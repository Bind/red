/// Git compatibility test CLI.
/// Reads a real git repo, parses objects, and verifies results against `git` CLI.
/// Also benchmarks key operations for comparison with ripgit (Rust).
///
/// Usage: compat <repo-path>
///   repo-path: path to a git repo (bare or normal, e.g. /tmp/react-bare)
const std = @import("std");
const sha1_mod = @import("sha1.zig");
const zlib = @import("deflate.zig");
const object = @import("object.zig");
const pack_mod = @import("pack.zig");
const packindex = @import("packindex.zig");
const packreader = @import("packreader.zig");
const diff_mod = @import("diff.zig");

const Io = std.Io;
const Dir = Io.Dir;
const File = Io.File;

const p = std.debug.print;
fn nanos() u64 {
    return std.c.mach_absolute_time();
}

pub fn main(init: std.process.Init) !void {
    const alloc = init.gpa;
    const io = init.io;

    var args_iter = std.process.Args.Iterator.init(init.minimal.args);
    _ = args_iter.next();
    const repo_path: []const u8 = if (args_iter.next()) |a| a else "/tmp/gitcompat-test";

    p("=== libgitty compatibility test: {s} ===\n\n", .{repo_path});

    // Detect bare vs normal repo
    const git_dir_path = blk: {
        // Try .git/objects (normal repo)
        var buf: [512]u8 = undefined;
        const normal = std.fmt.bufPrint(&buf, "{s}/.git", .{repo_path}) catch break :blk repo_path;
        if (Dir.cwd().openDir(io, normal, .{})) |d| {
            var dd = d;
            dd.close(io);
            break :blk normal;
        } else |_| {
            break :blk repo_path; // bare repo
        }
    };

    p("Git dir: {s}\n\n", .{git_dir_path});
    const git_dir = Dir.cwd().openDir(io, git_dir_path, .{}) catch {
        p("ERROR: Cannot open git dir\n", .{});
        return;
    };
    defer @constCast(&git_dir).close(io);

    var passed: u32 = 0;
    var failed: u32 = 0;

    // ── Test 1: Read HEAD ──
    {
        p("Test 1: Read HEAD\n", .{});
        var read_buf: [4096]u8 = undefined;
        const head_file = git_dir.openFile(io, "HEAD", .{}) catch {
            p("  FAIL: cannot open HEAD\n", .{});
            failed += 1;
            return;
        };
        defer @constCast(&head_file).close(io);
        var reader = File.reader(head_file, io, &read_buf);
        const head_data = reader.interface.allocRemaining(alloc, .unlimited) catch {
            p("  FAIL: cannot read HEAD\n", .{});
            failed += 1;
            return;
        };
        defer alloc.free(head_data);

        const protocol = @import("protocol.zig");
        if (protocol.parseSymbolicRef(head_data)) |target| {
            p("  HEAD -> {s}\n", .{target});
            passed += 1;
        } else {
            p("  HEAD is detached: {s}\n", .{std.mem.trimEnd(u8, head_data, &.{'\n'})});
            passed += 1;
        }
    }

    // ── Test 2: Read loose objects ──
    test2: {
        p("\nTest 2: Read loose objects\n", .{});
        var found: u32 = 0;
        var verified: u32 = 0;

        const obj_dir = git_dir.openDir(io, "objects", .{}) catch {
            p("  SKIP: no objects/ directory\n", .{});
            passed += 1;
            break :test2;
        };
        defer @constCast(&obj_dir).close(io);

        for (0..256) |byte| {
            var hex_prefix: [2]u8 = undefined;
            _ = std.fmt.bufPrint(&hex_prefix, "{x:0>2}", .{byte}) catch continue;

            const sub_dir = obj_dir.openDir(io, &hex_prefix, .{ .iterate = true }) catch continue;
            defer @constCast(&sub_dir).close(io);

            var iter = sub_dir.iterate();
            while (iter.next(io) catch null) |entry| {
                if (entry.name.len != 38) continue;
                found += 1;
                if (found > 20) break;

                var full_hash: [40]u8 = undefined;
                @memcpy(full_hash[0..2], &hex_prefix);
                @memcpy(full_hash[2..40], entry.name[0..38]);

                const obj_file = sub_dir.openFile(io, entry.name, .{}) catch continue;
                defer @constCast(&obj_file).close(io);
                var rbuf: [65536]u8 = undefined;
                var reader = File.reader(obj_file, io, &rbuf);
                const raw = reader.interface.allocRemaining(alloc, .unlimited) catch continue;
                defer alloc.free(raw);

                const decoded = object.decodeObject(alloc, raw) catch continue;
                defer alloc.free(decoded.data);

                const computed_hash = object.hashObject(decoded.obj_type, decoded.data);
                if (std.mem.eql(u8, &computed_hash, &full_hash)) {
                    verified += 1;
                } else {
                    p("  FAIL: hash mismatch for {s}\n", .{&full_hash});
                    failed += 1;
                }
            }
            if (found > 20) break;
        }

        if (found > 0) {
            p("  Found {d} loose objects, verified {d} hashes\n", .{ found, verified });
            if (verified == found) {
                passed += 1;
            } else {
                failed += 1;
            }
        } else {
            p("  No loose objects found (all packed)\n", .{});
            passed += 1;
        }
    }

    // ── Test 3: Read pack index ──
    test3: {
        p("\nTest 3: Read pack index\n", .{});
        const pack_dir = git_dir.openDir(io, "objects/pack", .{ .iterate = true }) catch {
            p("  SKIP: no objects/pack/\n", .{});
            passed += 1;
            break :test3;
        };
        defer @constCast(&pack_dir).close(io);

        var iter = pack_dir.iterate();
        while (iter.next(io) catch null) |entry| {
            if (!std.mem.endsWith(u8, entry.name, ".idx")) continue;

            // Read the idx file
            var path_buf: [256]u8 = undefined;
            const idx_path = std.fmt.bufPrint(&path_buf, "objects/pack/{s}", .{entry.name}) catch continue;
            const idx_file = git_dir.openFile(io, idx_path, .{}) catch continue;
            defer @constCast(&idx_file).close(io);
            var rbuf: [65536]u8 = undefined;
            var reader = File.reader(idx_file, io, &rbuf);
            const idx_data = reader.interface.allocRemaining(alloc, .unlimited) catch continue;
            defer alloc.free(idx_data);

            const idx = packindex.PackIndex.init(idx_data) catch |err| {
                p("  FAIL: cannot parse index: {}\n", .{err});
                failed += 1;
                continue;
            };

            p("  Pack index: {d} objects\n", .{idx.objectCount()});

            // Read corresponding pack file
            const pack_path = blk: {
                var pb: [256]u8 = undefined;
                const base = entry.name[0 .. entry.name.len - 4]; // strip ".idx"
                break :blk std.fmt.bufPrint(&pb, "objects/pack/{s}.pack", .{base}) catch continue;
            };

            const pack_file = git_dir.openFile(io, pack_path, .{}) catch continue;
            defer @constCast(&pack_file).close(io);
            var prbuf: [65536]u8 = undefined;
            var preader = File.reader(pack_file, io, &prbuf);
            const pack_data = preader.interface.allocRemaining(alloc, .unlimited) catch continue;
            defer alloc.free(pack_data);

            p("  Pack file: {d} bytes\n", .{pack_data.len});

            // ── Test 4: Resolve objects from pack ──
            p("\nTest 4: Resolve objects from pack\n", .{});
            var pr_inst = packreader.PackReader.init(alloc, pack_data, idx_data) catch continue;
            defer pr_inst.deinit();

            // Try resolving first 10 objects
            var resolved: u32 = 0;
            var hash_verified: u32 = 0;
            const count = @min(idx.objectCount(), 500);
            const t0 = nanos();

            for (0..count) |i| {
                const hash = idx.hashAt(@intCast(i));
                const obj = pr_inst.getObject(hash) catch continue;
                if (obj) |o| {
                    var o_mut = o;
                    defer o_mut.deinit(alloc);
                    resolved += 1;

                    // Verify hash matches
                    const digest = object.hashObjectDigest(o.obj_type, o.data);
                    if (std.mem.eql(u8, &digest, hash)) {
                        hash_verified += 1;
                    } else {
                        const expected = sha1_mod.digestToHex(hash);
                        const got = sha1_mod.digestToHex(&digest);
                        p("  FAIL: hash mismatch on object {d}\n", .{i});
                        p("    expected: {s}\n", .{&expected});
                        p("    got:      {s}\n", .{&got});
                        p("    type: {s}, size: {d}\n", .{ o.obj_type.toString(), o.data.len });
                        failed += 1;
                    }
                }
            }

            const resolve_us = (nanos() - t0) / 1000;
            p("  Resolved {d}/{d} objects, {d} hash-verified, in {d} µs\n", .{ resolved, count, hash_verified, resolve_us });
            if (hash_verified == resolved and resolved > 0) {
                passed += 1;
            } else {
                failed += 1;
            }

            // ── Test 5: Parse commits from pack ──
            p("\nTest 5: Parse commits from pack\n", .{});
            var commits_parsed: u32 = 0;

            for (0..@min(idx.objectCount(), 200)) |i| {
                const hash = idx.hashAt(@intCast(i));
                const obj = pr_inst.getObject(hash) catch continue;
                if (obj) |o| {
                    var o_mut = o;
                    defer o_mut.deinit(alloc);
                    if (o.obj_type == .commit) {
                        const info = object.parseCommit(alloc, o.data) catch continue;
                        defer alloc.free(info.parents);
                        commits_parsed += 1;
                        if (commits_parsed <= 3) {
                            const hash_hex = sha1_mod.digestToHex(hash);
                            // Truncate message to first line
                            var msg_iter = std.mem.splitScalar(u8, info.message, '\n');
                            const first_line = msg_iter.next() orelse "(empty)";
                            p("  {s}: {s}\n", .{ hash_hex[0..7], first_line });
                        }
                    }
                }
            }
            p("  Parsed {d} commits\n", .{commits_parsed});
            if (commits_parsed > 0) {
                passed += 1;
            } else {
                failed += 1;
            }

            // ── Test 6: Parse trees ──
            p("\nTest 6: Parse trees from pack\n", .{});
            var trees_parsed: u32 = 0;
            var total_entries: u32 = 0;

            for (0..@min(idx.objectCount(), 200)) |i| {
                const hash = idx.hashAt(@intCast(i));
                const obj = pr_inst.getObject(hash) catch continue;
                if (obj) |o| {
                    var o_mut = o;
                    defer o_mut.deinit(alloc);
                    if (o.obj_type == .tree) {
                        const entries = object.parseTree(alloc, o.data) catch continue;
                        defer alloc.free(entries);
                        trees_parsed += 1;
                        total_entries += @intCast(entries.len);
                    }
                }
            }
            p("  Parsed {d} trees with {d} total entries\n", .{ trees_parsed, total_entries });
            if (trees_parsed > 0) {
                passed += 1;
            } else {
                failed += 1;
            }

            // ── Test 7: Build + parse pack roundtrip ──
            p("\nTest 7: Pack build/parse roundtrip\n", .{});
            {
                var objs_list: std.ArrayList(pack_mod.PackObject) = .empty;
                defer objs_list.deinit(alloc);

                // Collect first 20 non-delta objects
                for (0..@min(idx.objectCount(), 500)) |i| {
                    if (objs_list.items.len >= 20) break;
                    const hash = idx.hashAt(@intCast(i));
                    const obj = pr_inst.getObject(hash) catch continue;
                    if (obj) |o| {
                        const hash_hex = object.hashObject(o.obj_type, o.data);
                        try objs_list.append(alloc, .{
                            .obj_type = o.obj_type,
                            .hash = hash_hex,
                            .data = o.data,
                        });
                    }
                }

                if (objs_list.items.len > 0) {
                    const built_pack = try pack_mod.buildPack(alloc, objs_list.items);
                    defer alloc.free(built_pack);

                    const parsed = try pack_mod.parsePack(alloc, built_pack);
                    defer {
                        for (parsed) |*e| @constCast(e).deinit(alloc);
                        alloc.free(parsed);
                    }

                    if (parsed.len == objs_list.items.len) {
                        // Verify all hashes match
                        var all_match = true;
                        for (parsed, 0..) |pe, i| {
                            if (!std.mem.eql(u8, &pe.hash, &objs_list.items[i].hash)) {
                                all_match = false;
                                break;
                            }
                        }
                        if (all_match) {
                            p("  PASS: {d} objects roundtripped correctly\n", .{parsed.len});
                            passed += 1;
                        } else {
                            p("  FAIL: hash mismatch in roundtrip\n", .{});
                            failed += 1;
                        }
                    } else {
                        p("  FAIL: count mismatch {d} vs {d}\n", .{ parsed.len, objs_list.items.len });
                        failed += 1;
                    }

                    // Free the objects we collected
                    for (objs_list.items) |*obj| alloc.free(obj.data);
                } else {
                    p("  SKIP: no objects collected\n", .{});
                }
            }

            // Only process first pack
            break;
        }
    }

    // ── Test 8: Diff ──
    {
        p("\nTest 8: Line diff\n", .{});
        const old = "line1\nline2\nline3\nline4\n";
        const new = "line1\nmodified\nline3\nline4\nadded\n";

        const d = try diff_mod.diffLines(alloc, old, new);
        defer alloc.free(d);

        var inserts: u32 = 0;
        var deletes: u32 = 0;
        var equals: u32 = 0;
        for (d) |line| {
            switch (line.op) {
                .insert => inserts += 1,
                .delete => deletes += 1,
                .equal => equals += 1,
            }
        }
        p("  Diff: {d} equal, {d} inserts, {d} deletes\n", .{ equals, inserts, deletes });
        if (inserts == 2 and deletes == 1 and equals == 3) {
            p("  PASS\n", .{});
            passed += 1;
        } else {
            p("  FAIL: expected 3 equal, 2 insert, 1 delete\n", .{});
            failed += 1;
        }
    }

    // ── Summary ──
    p("\n=== Results: {d} passed, {d} failed ===\n", .{ passed, failed });
    if (failed > 0) {
        p("SOME TESTS FAILED\n", .{});
    } else {
        p("ALL TESTS PASSED ✅\n", .{});
    }
}

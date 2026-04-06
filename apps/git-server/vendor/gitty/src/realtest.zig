/// Integration benchmark: exercises core git operations on the React repo.
/// Tests the same primitives ripgit uses: SHA-1, zlib, pack build/parse, delta.
///
/// Uses Zig 0.16's new Io abstraction for all file operations.
const std = @import("std");
const sha1_mod = @import("sha1.zig");
const zlib = @import("deflate.zig");
const object = @import("object.zig");
const pack_mod = @import("pack.zig");
const delta_mod = @import("delta.zig");

const Io = std.Io;
const Dir = Io.Dir;
const File = Io.File;

fn nanos() u64 {
    return std.c.mach_absolute_time();
}
const pr = std.debug.print;

/// Read a v2 pack index and return total object count.
fn readPackIdx(_: std.mem.Allocator, io: Io, dir: Dir, sub_path: []const u8) !usize {
    const file = try dir.openFile(io, sub_path, .{});
    defer file.close(io);

    // Read the header + fanout table (8 + 256*4 = 1032 bytes)
    const needed = 8 + 256 * 4;
    var buf: [needed]u8 = undefined;
    _ = try file.readPositionalAll(io, &buf, 0);
    if (buf[0] != 0xff or buf[1] != 't' or buf[2] != 'O' or buf[3] != 'c') return error.InvalidData;
    if (std.mem.readInt(u32, buf[4..8], .big) != 2) return error.InvalidData;

    return std.mem.readInt(u32, buf[8 + 255 * 4 ..][0..4], .big);
}

/// Read entire file into memory.
fn readFileAll(allocator: std.mem.Allocator, io: Io, dir: Dir, sub_path: []const u8) ![]u8 {
    const file = try dir.openFile(io, sub_path, .{});
    defer file.close(io);

    var read_buf: [65536]u8 = undefined;
    var reader = File.reader(file, io, &read_buf);
    return reader.interface.allocRemaining(allocator, .unlimited) catch return error.OutOfMemory;
}

pub fn main(init: std.process.Init) !void {
    const allocator = init.gpa;
    const io = init.io;

    // Get args
    var args_iter = std.process.Args.Iterator.init(init.minimal.args);
    _ = args_iter.next(); // skip argv[0]
    const repo_path: []const u8 = if (args_iter.next()) |arg| arg else "/tmp/react-bare";

    pr("=== libgitty real-repo benchmark: {s} ===\n", .{repo_path});
    pr("Same primitives as ripgit: SHA-1, zlib, object encode/decode, pack, delta\n\n", .{});

    const repo_dir = Dir.cwd().openDir(io, repo_path, .{}) catch {
        pr("ERROR: Cannot open repo at {s}\n", .{repo_path});
        pr("Run: git clone --bare https://github.com/facebook/react.git /tmp/react-bare\n", .{});
        return;
    };
    defer repo_dir.close(io);

    // ── 1. Read pack index ──
    if (repo_dir.openDir(io, "objects/pack", .{ .iterate = true })) |pack_dir_val| {
        var pack_dir = pack_dir_val;
        defer pack_dir.close(io);

        var iter = pack_dir.iterate();
        var idx_name_buf: [256]u8 = undefined;
        var idx_name_len: usize = 0;
        while (try iter.next(io)) |entry| {
            if (std.mem.endsWith(u8, entry.name, ".idx")) {
                @memcpy(idx_name_buf[0..entry.name.len], entry.name);
                idx_name_len = entry.name.len;
            }
        }

        if (idx_name_len > 0) {
            var path_buf: [512]u8 = undefined;
            const sub = std.fmt.bufPrint(&path_buf, "objects/pack/{s}", .{idx_name_buf[0..idx_name_len]}) catch unreachable;

            const t0 = nanos();
            const count = try readPackIdx(allocator, io, repo_dir, sub);
            const us = (nanos() - t0) / 1000;
            pr("1. Pack index: {d} objects in {d} µs\n", .{ count, us });
            pr("METRIC idx_objects={d}\n", .{count});
            pr("METRIC idx_read_µs={d}\n\n", .{us});
        }
    } else |_| {
        pr("1. Pack index: cannot open objects/pack\n\n", .{});
    }

    // ── 2. SHA-1 hashing: 100MB throughput ──
    // ripgit uses sha1_smol (pure Rust). We use std.crypto.hash.Sha1.
    {
        const data = "x" ** 10000;
        const iters: usize = 10_000;
        const t0 = nanos();
        for (0..iters) |_| {
            const h = sha1_mod.Sha1.hash(data);
            std.mem.doNotOptimizeAway(&h);
        }
        const us = (nanos() - t0) / 1000;
        const mbps = @as(f64, @floatFromInt(iters * data.len)) / (@as(f64, @floatFromInt(us)) / 1e6) / (1024.0 * 1024.0);
        pr("2. SHA-1: {d} µs for 100MB ({d:.0} MB/s)\n", .{ us, mbps });
        pr("METRIC sha1_100mb_µs={d}\n\n", .{us});
    }

    // ── 3. Zlib compress+decompress: React-like source x 1000 ──
    // ripgit uses flate2 rust_backend. We use std.compress.flate.
    {
        const src =
            \\import React from 'react';
            \\import {useState, useEffect} from 'react';
            \\export default function App() {
            \\  const [count, setCount] = useState(0);
            \\  const [items, setItems] = useState([]);
            \\  useEffect(() => { fetch('/api').then(r=>r.json()).then(setItems) }, []);
            \\  return <div><h1>{count}</h1><button onClick={()=>setCount(c=>c+1)}>+</button>
            \\    <ul>{items.map(i=><li key={i.id}>{i.name}</li>)}</ul></div>;
            \\}
        ;
        const big = src ++ src ++ src ++ src ++ src ++ src ++ src;
        const iters: usize = 1_000;
        var comp_bytes: usize = 0;

        const t0 = nanos();
        for (0..iters) |_| {
            const comp = try zlib.deflate(allocator, big);
            defer allocator.free(comp);
            comp_bytes += comp.len;
            const decomp = try zlib.inflate(allocator, comp);
            defer allocator.free(decomp);
            std.mem.doNotOptimizeAway(decomp.ptr);
        }
        const us = (nanos() - t0) / 1000;
        const ratio = @as(f64, @floatFromInt(big.len * iters)) / @as(f64, @floatFromInt(comp_bytes));
        pr("3. Zlib: {d} µs for {d}x{d}B (ratio {d:.1}x)\n", .{ us, iters, big.len, ratio });
        pr("METRIC zlib_1k_µs={d}\n\n", .{us});
    }

    // ── 4. Object encode+decode: 1000 x 10KB blobs ──
    {
        const data = "y" ** 10000;
        const iters: usize = 1_000;
        const t0 = nanos();
        for (0..iters) |_| {
            const enc = try object.encodeObject(allocator, .blob, data);
            defer allocator.free(enc);
            const dec = try object.decodeObject(allocator, enc);
            defer allocator.free(dec.data);
            std.mem.doNotOptimizeAway(dec.data.ptr);
        }
        const us = (nanos() - t0) / 1000;
        pr("4. Object encode+decode: {d} µs for {d}x10KB\n", .{ us, iters });
        pr("METRIC obj_1k_µs={d}\n\n", .{us});
    }

    // ── 5. Pack build+parse: 100 x 1KB objects, 10 runs ──
    {
        const N = 100;
        var blob_bufs: [N][1024]u8 = undefined;
        var objs: [N]pack_mod.PackObject = undefined;
        for (0..N) |i| {
            @memset(&blob_bufs[i], @as(u8, @intCast((i * 7 + 13) % 256)));
            objs[i] = .{
                .obj_type = .blob,
                .hash = object.hashObject(.blob, &blob_bufs[i]),
                .data = &blob_bufs[i],
            };
        }

        var build_us: u64 = 0;
        var parse_us: u64 = 0;
        var pack_size: usize = 0;

        for (0..10) |_| {
            const t0 = nanos();
            const pd = try pack_mod.buildPack(allocator, &objs);
            build_us += (nanos() - t0) / 1000;
            pack_size = pd.len;

            const t1 = nanos();
            const entries = try pack_mod.parsePack(allocator, pd);
            parse_us += (nanos() - t1) / 1000;

            for (entries) |*e| @constCast(e).deinit(allocator);
            allocator.free(entries);
            allocator.free(pd);
        }

        pr("5. Pack (100 obj, 10 runs): build {d} µs, parse {d} µs, size {d}B\n", .{ build_us, parse_us, pack_size });
        pr("METRIC pack_build_µs={d}\n", .{build_us});
        pr("METRIC pack_parse_µs={d}\n\n", .{parse_us});
    }

    // ── 6. Delta create+apply: 1000 iterations ──
    {
        const base = "The quick brown fox jumps over the lazy dog. " ** 50;
        const target = "The quick brown fox leaps over the lazy cat. " ** 50;
        const iters: usize = 1_000;

        const t0 = nanos();
        for (0..iters) |_| {
            const dd = try delta_mod.createDelta(allocator, base, target);
            defer allocator.free(dd);
            const r = try delta_mod.applyDelta(allocator, base, dd);
            defer allocator.free(r);
            std.mem.doNotOptimizeAway(r.ptr);
        }
        const us = (nanos() - t0) / 1000;
        pr("6. Delta create+apply: {d} µs for {d} iters\n", .{ us, iters });
        pr("METRIC delta_1k_µs={d}\n\n", .{us});
    }

    // ── 7. Hash object (git hash-object equivalent) ──
    {
        const data = "z" ** 10000;
        const iters: usize = 10_000;
        const t0 = nanos();
        for (0..iters) |_| {
            const h = object.hashObject(.blob, data);
            std.mem.doNotOptimizeAway(&h);
        }
        const us = (nanos() - t0) / 1000;
        pr("7. hash-object: {d} µs for {d}x10KB\n", .{ us, iters });
        pr("METRIC hashobj_10k_µs={d}\n\n", .{us});
    }

    // ── 8. Read and decode loose objects from React repo ──
    {
        // Try reading HEAD ref
        const head_data = readFileAll(allocator, io, repo_dir, "HEAD") catch null;
        if (head_data) |hd| {
            defer allocator.free(hd);
            pr("8. HEAD: {s}", .{hd});
        }
    }

    pr("=== Done. Compare against: git commands / ripgit Rust benchmarks ===\n", .{});
}

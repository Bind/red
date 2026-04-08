/// Benchmarks for libgitty vs libgit2 (system git).
/// Tests real git operations on the React repository.
const std = @import("std");
const sha1_mod = @import("sha1.zig");
const zlib = @import("deflate.zig");
const object = @import("object.zig");
const pack_mod = @import("pack.zig");
const delta_mod = @import("delta.zig");

fn nanos() u64 {
    return std.c.mach_absolute_time();
}

// ── Micro-benchmarks (synthetic) ──

fn benchSha1() u64 {
    const iters = 10_000;
    const data = "The quick brown fox jumps over the lazy dog. " ** 100;
    const t0 = nanos();
    for (0..iters) |_| {
        const d = sha1_mod.Sha1.hash(data);
        std.mem.doNotOptimizeAway(&d);
    }
    return (nanos() - t0) / 1000;
}

fn benchDeflate() !u64 {
    const alloc = std.heap.page_allocator;
    const iters = 1_000;
    const data = "Hello, git world! This is some test data for compression benchmarks. " ** 50;
    const t0 = nanos();
    for (0..iters) |_| {
        const c = try zlib.deflate(alloc, data);
        defer alloc.free(c);
        const d = try zlib.inflate(alloc, c);
        defer alloc.free(d);
        std.mem.doNotOptimizeAway(d.ptr);
    }
    return (nanos() - t0) / 1000;
}

fn benchObjHash() u64 {
    const iters = 10_000;
    const data = "function hello() {\n  console.log('Hello, world!');\n}\n" ** 20;
    const t0 = nanos();
    for (0..iters) |_| {
        const h = object.hashObject(.blob, data);
        std.mem.doNotOptimizeAway(&h);
    }
    return (nanos() - t0) / 1000;
}

fn benchPack() !u64 {
    const alloc = std.heap.page_allocator;
    const iters = 100;
    const objects = [_]pack_mod.PackObject{
        .{ .obj_type = .blob, .hash = object.hashObject(.blob, "file1 content\n"), .data = "file1 content\n" },
        .{ .obj_type = .blob, .hash = object.hashObject(.blob, "file2 with more content\n"), .data = "file2 with more content\n" },
        .{ .obj_type = .blob, .hash = object.hashObject(.blob, "a larger file " ** 100), .data = "a larger file " ** 100 },
    };
    const t0 = nanos();
    for (0..iters) |_| {
        const pd = try pack_mod.buildPack(alloc, &objects);
        defer alloc.free(pd);
        const entries = try pack_mod.parsePack(alloc, pd);
        defer {
            for (entries) |*e| @constCast(e).deinit(alloc);
            alloc.free(entries);
        }
        std.mem.doNotOptimizeAway(entries.ptr);
    }
    return (nanos() - t0) / 1000;
}

fn benchDelta() !u64 {
    const alloc = std.heap.page_allocator;
    const iters = 1_000;
    const base = "The quick brown fox jumps over the lazy dog. " ** 50;
    const target = "The quick brown fox leaps over the lazy cat. " ** 50;
    const t0 = nanos();
    for (0..iters) |_| {
        const dd = try delta_mod.createDelta(alloc, base, target);
        defer alloc.free(dd);
        const r = try delta_mod.applyDelta(alloc, base, dd);
        defer alloc.free(r);
        std.mem.doNotOptimizeAway(r.ptr);
    }
    return (nanos() - t0) / 1000;
}

pub fn main() !void {
    const p = std.debug.print;

    const sha1_us = benchSha1();
    p("METRIC sha1_µs={d}\n", .{sha1_us});

    const deflate_us = try benchDeflate();
    p("METRIC deflate_µs={d}\n", .{deflate_us});

    const obj_hash_us = benchObjHash();
    p("METRIC obj_hash_µs={d}\n", .{obj_hash_us});

    const pack_us = try benchPack();
    p("METRIC pack_µs={d}\n", .{pack_us});

    const delta_us = try benchDelta();
    p("METRIC delta_µs={d}\n", .{delta_us});

    const total = sha1_us + deflate_us + obj_hash_us + pack_us + delta_us;
    p("METRIC total_µs={d}\n", .{total});
}

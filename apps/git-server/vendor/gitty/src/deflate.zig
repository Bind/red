/// Zlib compression/decompression — pure Zig std lib, zero external dependencies.
///
/// Uses std.compress.flate for both compression (LZ77 + Huffman) and
/// decompression.  Zig 0.16-dev has a complete, production-quality
/// DEFLATE implementation with configurable compression levels.
const std = @import("std");

// ───────────────────────── public API ─────────────────────────

/// Decompress zlib-wrapped data.  Caller owns returned slice.
pub fn inflate(allocator: std.mem.Allocator, data: []const u8) ![]u8 {
    var reader = std.Io.Reader.fixed(data);
    var buf: [std.compress.flate.max_window_len]u8 = undefined;
    var decomp = std.compress.flate.Decompress.init(&reader, .zlib, &buf);
    return decomp.reader.allocRemaining(allocator, .unlimited) catch return error.InvalidData;
}

/// Decompress + report how many compressed bytes were consumed.
/// Essential for pack-file parsing where objects are concatenated.
///
/// Uses Reader.seek to track exactly how many bytes the decompressor consumed
/// from the input — zero overhead compared to plain inflate.
pub fn inflateWithSize(allocator: std.mem.Allocator, data: []const u8) !struct { data: []u8, compressed_size: usize } {
    var reader = std.Io.Reader.fixed(data);
    var buf: [std.compress.flate.max_window_len]u8 = undefined;
    var decomp = std.compress.flate.Decompress.init(&reader, .zlib, &buf);
    const result = decomp.reader.allocRemaining(allocator, .unlimited) catch return error.InvalidData;
    return .{ .data = result, .compressed_size = reader.seek };
}

/// Compress data into a valid zlib stream.
/// Level 2: good balance of speed and ratio (~9.7x on source code).
/// Caller owns returned slice.
pub fn deflate(allocator: std.mem.Allocator, data: []const u8) ![]u8 {
    return deflateLevel(allocator, data, .level_2);
}

/// Compress with level 1 for maximum throughput.
/// Used in pack building where speed matters more than ratio.
pub fn deflateFast(allocator: std.mem.Allocator, data: []const u8) ![]u8 {
    return deflateLevel(allocator, data, .level_1);
}

fn deflateLevel(allocator: std.mem.Allocator, data: []const u8, level: std.compress.flate.Compress.Options) ![]u8 {
    var aw: std.Io.Writer.Allocating = try .initCapacity(allocator, @max(data.len / 2, 64));
    errdefer aw.deinit();

    var comp_buf: [std.compress.flate.max_window_len]u8 = undefined;
    var comp = std.compress.flate.Compress.init(&aw.writer, &comp_buf, .zlib, level) catch return error.OutOfMemory;
    comp.writer.writeAll(data) catch return error.OutOfMemory;
    comp.finish() catch return error.OutOfMemory;

    return aw.toOwnedSlice();
}

// ──────────────────────── tests ────────────────────────

test "roundtrip" {
    const a = std.testing.allocator;
    const orig = "Hello, git world! This is a test of deflate compression.";
    const c = try deflate(a, orig);
    defer a.free(c);
    const d = try inflate(a, c);
    defer a.free(d);
    try std.testing.expectEqualStrings(orig, d);
}

test "empty" {
    const a = std.testing.allocator;
    const c = try deflate(a, "");
    defer a.free(c);
    const d = try inflate(a, c);
    defer a.free(d);
    try std.testing.expectEqual(@as(usize, 0), d.len);
}

test "large repeated data compresses well" {
    const a = std.testing.allocator;
    const orig = "A" ** 100_000;
    const c = try deflate(a, orig);
    defer a.free(c);
    try std.testing.expect(c.len < orig.len / 10);
    const d = try inflate(a, c);
    defer a.free(d);
    try std.testing.expectEqualStrings(orig, d);
}

test "inflateWithSize tracks consumed bytes" {
    const a = std.testing.allocator;
    const orig = "test data for inflate with size tracking!!!!";
    const c = try deflate(a, orig);
    defer a.free(c);

    // append trailing garbage to simulate pack stream
    const trail = try a.alloc(u8, c.len + 10);
    defer a.free(trail);
    @memcpy(trail[0..c.len], c);
    @memset(trail[c.len..], 0xAB);

    const r = try inflateWithSize(a, trail);
    defer a.free(r.data);
    try std.testing.expectEqualStrings(orig, r.data);
    try std.testing.expectEqual(c.len, r.compressed_size);
}

test "deflateFast roundtrip" {
    const a = std.testing.allocator;
    const orig = "the quick brown fox jumps over the lazy dog. " ** 100;
    const c = try deflateFast(a, orig);
    defer a.free(c);
    const d = try inflate(a, c);
    defer a.free(d);
    try std.testing.expectEqualStrings(orig, d);
}

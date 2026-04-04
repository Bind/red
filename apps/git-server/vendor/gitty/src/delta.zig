/// Git delta compression/decompression.
/// Implements the OFS_DELTA and REF_DELTA formats used in pack files.
const std = @import("std");

pub const DeltaError = error{
    InvalidDelta,
    BaseSizeMismatch,
    ResultSizeMismatch,
    OutOfMemory,
};

/// Apply a git delta instruction stream to a base buffer.
/// Returns the reconstructed object.
pub fn applyDelta(allocator: std.mem.Allocator, base: []const u8, delta_data: []const u8) ![]u8 {
    var offset: usize = 0;

    // Read base size (variable-length encoding)
    const base_size = readVarInt(delta_data, &offset);
    if (base_size != base.len) return error.BaseSizeMismatch;

    // Read result size
    const result_size = readVarInt(delta_data, &offset);

    const result = try allocator.alloc(u8, result_size);
    errdefer allocator.free(result);
    var result_offset: usize = 0;

    while (offset < delta_data.len) {
        const cmd = delta_data[offset];
        offset += 1;

        if (cmd & 0x80 != 0) {
            // Copy from base
            var copy_offset: usize = 0;
            var copy_size: usize = 0;

            if (cmd & 0x01 != 0) {
                copy_offset = delta_data[offset];
                offset += 1;
            }
            if (cmd & 0x02 != 0) {
                copy_offset |= @as(usize, delta_data[offset]) << 8;
                offset += 1;
            }
            if (cmd & 0x04 != 0) {
                copy_offset |= @as(usize, delta_data[offset]) << 16;
                offset += 1;
            }
            if (cmd & 0x08 != 0) {
                copy_offset |= @as(usize, delta_data[offset]) << 24;
                offset += 1;
            }
            if (cmd & 0x10 != 0) {
                copy_size = delta_data[offset];
                offset += 1;
            }
            if (cmd & 0x20 != 0) {
                copy_size |= @as(usize, delta_data[offset]) << 8;
                offset += 1;
            }
            if (cmd & 0x40 != 0) {
                copy_size |= @as(usize, delta_data[offset]) << 16;
                offset += 1;
            }
            if (copy_size == 0) copy_size = 0x10000;

            @memcpy(result[result_offset..][0..copy_size], base[copy_offset..][0..copy_size]);
            result_offset += copy_size;
        } else if (cmd > 0) {
            // Insert new data
            @memcpy(result[result_offset..][0..cmd], delta_data[offset..][0..cmd]);
            offset += cmd;
            result_offset += cmd;
        }
        // cmd == 0 is reserved
    }

    if (result_offset != result_size) return error.ResultSizeMismatch;
    return result;
}

/// Create a delta from base to target.
pub fn createDelta(allocator: std.mem.Allocator, base: []const u8, target: []const u8) ![]u8 {
    var output: std.ArrayList(u8) = .empty;
    errdefer output.deinit(allocator);

    // Write base size
    try writeVarInt(allocator, &output, base.len);
    // Write target size
    try writeVarInt(allocator, &output, target.len);

    if (base.len == 0) {
        // No base to copy from, just insert everything
        var pos: usize = 0;
        while (pos < target.len) {
            const chunk: u8 = @intCast(@min(127, target.len - pos));
            try output.append(allocator, chunk);
            try output.appendSlice(allocator, target[pos..][0..chunk]);
            pos += chunk;
        }
        return output.toOwnedSlice(allocator);
    }

    // Build index of 4-byte windows in base using a simple open-addressing table.
    // Power-of-2 size for fast modulo. Sentinel 0xFFFFFFFF = empty slot.
    // Use stack buffers for small bases to avoid allocator overhead.
    const EMPTY: u32 = 0xFFFFFFFF;
    const table_size: usize = if (base.len < 256) 256 else if (base.len < 4096) 4096 else 16384;
    const table_mask: u32 = @intCast(table_size - 1);

    // Stack buffer for small tables, heap for large
    var stack_keys: [4096]u32 = undefined;
    var stack_vals: [4096]u32 = undefined;
    const table_keys = if (table_size <= 4096) stack_keys[0..table_size] else try allocator.alloc(u32, table_size);
    defer if (table_size > 4096) allocator.free(table_keys);
    const table_vals = if (table_size <= 4096) stack_vals[0..table_size] else try allocator.alloc(u32, table_size);
    defer if (table_size > 4096) allocator.free(table_vals);
    @memset(table_keys, EMPTY);

    if (base.len >= 4) {
        var i: usize = 0;
        while (i + 4 <= base.len) : (i += 1) {
            const key = std.mem.readInt(u32, base[i..][0..4], .big);
            var slot = key & table_mask;
            // Linear probe, first-match wins
            while (table_keys[slot] != EMPTY and table_keys[slot] != key) {
                slot = (slot + 1) & table_mask;
            }
            if (table_keys[slot] == EMPTY) {
                table_keys[slot] = key;
                table_vals[slot] = @intCast(i);
            }
        }
    }

    var tpos: usize = 0;
    var insert_start: usize = 0;

    while (tpos < target.len) {
        var best_offset: usize = 0;
        var best_len: usize = 0;

        // Try to find a match in base
        if (tpos + 4 <= target.len) {
            const key = std.mem.readInt(u32, target[tpos..][0..4], .big);
            var slot = key & table_mask;
            while (table_keys[slot] != EMPTY) {
                if (table_keys[slot] == key) {
                    const base_offset = table_vals[slot];
                    // Extend match
                    var match_len: usize = 0;
                    while (base_offset + match_len < base.len and
                        tpos + match_len < target.len and
                        base[base_offset + match_len] == target[tpos + match_len])
                    {
                        match_len += 1;
                    }
                    if (match_len >= 4) {
                        best_offset = base_offset;
                        best_len = match_len;
                    }
                    break;
                }
                slot = (slot + 1) & table_mask;
            }
        }

        if (best_len >= 4) {
            // Flush pending inserts
            if (tpos > insert_start) {
                try flushInserts(allocator, &output, target[insert_start..tpos]);
            }

            // Emit copy instruction
            try emitCopy(allocator, &output, best_offset, best_len);
            tpos += best_len;
            insert_start = tpos;
        } else {
            tpos += 1;
        }
    }

    // Flush remaining inserts
    if (tpos > insert_start) {
        try flushInserts(allocator, &output, target[insert_start..tpos]);
    }

    return output.toOwnedSlice(allocator);
}

fn flushInserts(allocator: std.mem.Allocator, output: *std.ArrayList(u8), data: []const u8) !void {
    var pos: usize = 0;
    while (pos < data.len) {
        const chunk: u8 = @intCast(@min(127, data.len - pos));
        try output.append(allocator, chunk);
        try output.appendSlice(allocator, data[pos..][0..chunk]);
        pos += chunk;
    }
}

fn emitCopy(allocator: std.mem.Allocator, output: *std.ArrayList(u8), offset: usize, size: usize) !void {
    var cmd: u8 = 0x80;
    var extra: [7]u8 = undefined;
    var extra_len: usize = 0;

    if (offset & 0xFF != 0) {
        cmd |= 0x01;
        extra[extra_len] = @intCast(offset & 0xFF);
        extra_len += 1;
    }
    if (offset & 0xFF00 != 0) {
        cmd |= 0x02;
        extra[extra_len] = @intCast((offset >> 8) & 0xFF);
        extra_len += 1;
    }
    if (offset & 0xFF0000 != 0) {
        cmd |= 0x04;
        extra[extra_len] = @intCast((offset >> 16) & 0xFF);
        extra_len += 1;
    }
    if (offset & 0xFF000000 != 0) {
        cmd |= 0x08;
        extra[extra_len] = @intCast((offset >> 24) & 0xFF);
        extra_len += 1;
    }

    const actual_size = if (size == 0x10000) @as(usize, 0) else size;
    if (actual_size & 0xFF != 0) {
        cmd |= 0x10;
        extra[extra_len] = @intCast(actual_size & 0xFF);
        extra_len += 1;
    }
    if (actual_size & 0xFF00 != 0) {
        cmd |= 0x20;
        extra[extra_len] = @intCast((actual_size >> 8) & 0xFF);
        extra_len += 1;
    }
    if (actual_size & 0xFF0000 != 0) {
        cmd |= 0x40;
        extra[extra_len] = @intCast((actual_size >> 16) & 0xFF);
        extra_len += 1;
    }

    try output.append(allocator, cmd);
    try output.appendSlice(allocator, extra[0..extra_len]);
}

fn readVarInt(data: []const u8, offset: *usize) usize {
    var result: usize = 0;
    var shift: u6 = 0;
    while (offset.* < data.len) {
        const byte = data[offset.*];
        offset.* += 1;
        result |= @as(usize, byte & 0x7f) << @intCast(shift);
        if (byte & 0x80 == 0) break;
        shift +|= 7;
    }
    return result;
}

fn writeVarInt(allocator: std.mem.Allocator, output: *std.ArrayList(u8), value: usize) !void {
    var v = value;
    while (true) {
        var byte: u8 = @intCast(v & 0x7f);
        v >>= 7;
        if (v > 0) byte |= 0x80;
        try output.append(allocator, byte);
        if (v == 0) break;
    }
}

test "delta apply simple" {
    const allocator = std.testing.allocator;
    const base = "Hello, world! This is a test.";
    const target = "Hello, world! This is a modified test.";

    const delta_data = try createDelta(allocator, base, target);
    defer allocator.free(delta_data);

    const result = try applyDelta(allocator, base, delta_data);
    defer allocator.free(result);

    try std.testing.expectEqualStrings(target, result);
}

test "delta empty base" {
    const allocator = std.testing.allocator;
    const base = "";
    const target = "new content";

    const delta_data = try createDelta(allocator, base, target);
    defer allocator.free(delta_data);

    const result = try applyDelta(allocator, base, delta_data);
    defer allocator.free(result);

    try std.testing.expectEqualStrings(target, result);
}

test "delta identical" {
    const allocator = std.testing.allocator;
    const data = "identical content here";

    const delta_data = try createDelta(allocator, data, data);
    defer allocator.free(delta_data);

    const result = try applyDelta(allocator, data, delta_data);
    defer allocator.free(result);

    try std.testing.expectEqualStrings(data, result);
}

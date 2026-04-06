/// Git pack file parsing and building.
/// Handles PACK v2 format including OFS_DELTA and REF_DELTA objects.
const std = @import("std");
const sha1_mod = @import("sha1.zig");
const zlib = @import("deflate.zig");
const delta_mod = @import("delta.zig");
const object = @import("object.zig");

pub const OBJ_COMMIT: u3 = 1;
pub const OBJ_TREE: u3 = 2;
pub const OBJ_BLOB: u3 = 3;
pub const OBJ_TAG: u3 = 4;
pub const OBJ_OFS_DELTA: u3 = 6;
pub const OBJ_REF_DELTA: u3 = 7;

/// Lightweight metadata for one entry in a pack file.
/// Does NOT hold decompressed data — just offsets and type info.
/// Used by the two-pass streaming parser for O(1) memory per object.
pub const PackEntryMeta = struct {
    /// Byte offset of the data (after header) in the pack
    data_offset: usize,
    /// Pack-level type number (1-4 for regular, 6=OFS_DELTA, 7=REF_DELTA)
    type_num: u3,
    /// Decompressed size from the pack header
    size: usize,
    /// For OFS_DELTA: absolute byte offset of the base entry
    base_pack_offset: ?usize,
    /// For REF_DELTA: SHA-1 hash of the base object
    base_hash: ?sha1_mod.Digest,
    /// Byte offset of this entry's header in the pack (for offset references)
    entry_offset: usize,
};

/// Build a lightweight index of all entries in a pack file.
/// Walks the pack byte stream, decompressing data to /dev/null just to
/// find entry boundaries. Returns metadata for each entry.
/// This is the "index pass" of the two-pass streaming parser.
/// O(1) memory per object (no decompressed data retained).
pub fn indexPack(allocator: std.mem.Allocator, buf: []const u8) ![]PackEntryMeta {
    if (buf.len < 12) return error.InvalidData;
    if (!std.mem.eql(u8, buf[0..4], "PACK")) return error.InvalidData;
    const version = std.mem.readInt(u32, buf[4..8], .big);
    if (version != 2 and version != 3) return error.InvalidData;
    const num_objects = std.mem.readInt(u32, buf[8..12], .big);

    var entries: std.ArrayList(PackEntryMeta) = .empty;
    errdefer entries.deinit(allocator);
    try entries.ensureTotalCapacity(allocator, num_objects);

    var offset: usize = 12;

    for (0..num_objects) |_| {
        const entry_offset = offset;

        // Read type+size header
        var byte = buf[offset];
        offset += 1;
        const type_num: u3 = @intCast((byte >> 4) & 0x07);
        var size: usize = byte & 0x0f;
        var shift: u6 = 4;
        while (byte & 0x80 != 0) {
            byte = buf[offset];
            offset += 1;
            size |= @as(usize, byte & 0x7f) << shift;
            shift +|= 7;
        }

        var base_pack_offset: ?usize = null;
        var base_hash: ?sha1_mod.Digest = null;

        if (type_num == OBJ_OFS_DELTA) {
            var delta_byte = buf[offset];
            offset += 1;
            var neg_offset: usize = delta_byte & 0x7f;
            while (delta_byte & 0x80 != 0) {
                delta_byte = buf[offset];
                offset += 1;
                neg_offset = ((neg_offset + 1) << 7) | (delta_byte & 0x7f);
            }
            base_pack_offset = entry_offset - neg_offset;
        } else if (type_num == OBJ_REF_DELTA) {
            var hash: sha1_mod.Digest = undefined;
            @memcpy(&hash, buf[offset..][0..20]);
            base_hash = hash;
            offset += 20;
        }

        const data_offset = offset;

        // Skip compressed data by decompressing to find the boundary
        const inflate_result = try zlib.inflateWithSize(allocator, buf[offset..]);
        allocator.free(inflate_result.data); // discard decompressed data
        offset += inflate_result.compressed_size;

        try entries.append(allocator, .{
            .data_offset = data_offset,
            .type_num = type_num,
            .size = size,
            .base_pack_offset = base_pack_offset,
            .base_hash = base_hash,
            .entry_offset = entry_offset,
        });
    }

    return entries.toOwnedSlice(allocator);
}

pub const PackEntry = struct {
    obj_type: object.ObjectType,
    hash: [40]u8,
    data: []u8,

    pub fn deinit(self: *PackEntry, allocator: std.mem.Allocator) void {
        allocator.free(self.data);
    }
};

pub const PackObject = struct {
    obj_type: object.ObjectType,
    hash: [40]u8,
    data: []const u8,
};

pub const ResolvedBaseObject = struct {
    obj_type: object.ObjectType,
    data: []u8,

    pub fn deinit(self: *ResolvedBaseObject, allocator: std.mem.Allocator) void {
        allocator.free(self.data);
    }
};

pub const ExternalBaseResolver = struct {
    ctx: *const anyopaque,
    resolve: *const fn (
        ctx: *const anyopaque,
        allocator: std.mem.Allocator,
        hash: []const u8,
    ) anyerror!?ResolvedBaseObject,
};

/// Parse a git pack stream into resolved objects.
pub fn parsePack(allocator: std.mem.Allocator, buf: []const u8) ![]PackEntry {
    return parsePackWithExternalBases(allocator, buf, null);
}

pub fn parsePackWithExternalBases(
    allocator: std.mem.Allocator,
    buf: []const u8,
    external_base_resolver: ?ExternalBaseResolver,
) ![]PackEntry {
    if (buf.len < 12) return error.InvalidData;

    // Verify PACK signature
    if (!std.mem.eql(u8, buf[0..4], "PACK")) return error.InvalidData;

    const version = std.mem.readInt(u32, buf[4..8], .big);
    if (version != 2 and version != 3) return error.InvalidData;

    const num_objects = std.mem.readInt(u32, buf[8..12], .big);
    var offset: usize = 12;

    var entries: std.ArrayList(PackEntry) = .empty;
    errdefer {
        for (entries.items) |*e| e.deinit(allocator);
        entries.deinit(allocator);
    }
    try entries.ensureTotalCapacity(allocator, num_objects);

    // Track resolved objects by their pack offset for OFS_DELTA
    var resolved_by_offset = std.AutoHashMap(usize, struct { obj_type: object.ObjectType, data: []const u8 }).init(allocator);
    defer resolved_by_offset.deinit();

    for (0..num_objects) |_| {
        const entry_offset = offset;

        // Read variable-length type+size header
        var byte = buf[offset];
        offset += 1;
        const obj_type_raw: u3 = @intCast((byte >> 4) & 0x07);
        var shift: u6 = 4;

        while (byte & 0x80 != 0) {
            byte = buf[offset];
            offset += 1;
            shift +|= 7;
        }

        if (obj_type_raw == OBJ_OFS_DELTA) {
            // Read negative offset (variable-length, different encoding)
            var delta_offset_byte = buf[offset];
            offset += 1;
            var neg_offset: usize = delta_offset_byte & 0x7f;
            while (delta_offset_byte & 0x80 != 0) {
                delta_offset_byte = buf[offset];
                offset += 1;
                neg_offset = ((neg_offset + 1) << 7) | (delta_offset_byte & 0x7f);
            }
            const base_offset = entry_offset - neg_offset;

            // Decompress delta data
            const inflate_result = try zlib.inflateWithSize(allocator, buf[offset..]);
            defer allocator.free(inflate_result.data);
            offset += inflate_result.compressed_size;

            // Resolve base
            const base = resolved_by_offset.get(base_offset) orelse return error.InvalidData;
            const resolved = try delta_mod.applyDelta(allocator, base.data, inflate_result.data);

            const hash = object.hashObject(base.obj_type, resolved);
            try resolved_by_offset.put(entry_offset, .{ .obj_type = base.obj_type, .data = resolved });
            try entries.append(allocator, .{ .obj_type = base.obj_type, .hash = hash, .data = resolved });
        } else if (obj_type_raw == OBJ_REF_DELTA) {
            // 20-byte base hash
            var base_hash_bytes: [20]u8 = undefined;
            @memcpy(&base_hash_bytes, buf[offset..][0..20]);
            const base_hash_hex = sha1_mod.digestToHex(&base_hash_bytes);
            offset += 20;

            // Decompress delta data
            const inflate_result = try zlib.inflateWithSize(allocator, buf[offset..]);
            defer allocator.free(inflate_result.data);
            offset += inflate_result.compressed_size;

            // Find base in already-parsed entries
            var base_entry: ?*const PackEntry = null;
            for (entries.items) |*e| {
                if (std.mem.eql(u8, &e.hash, &base_hash_hex)) {
                    base_entry = e;
                    break;
                }
            }
            const resolved_base = if (base_entry) |base| blk: {
                break :blk ResolvedBaseObject{
                    .obj_type = base.obj_type,
                    .data = try allocator.dupe(u8, base.data),
                };
            } else if (external_base_resolver) |resolver| blk: {
                const base = try resolver.resolve(resolver.ctx, allocator, &base_hash_hex) orelse return error.InvalidData;
                break :blk base;
            } else return error.InvalidData;
            defer {
                var base = resolved_base;
                base.deinit(allocator);
            }

            const resolved = try delta_mod.applyDelta(allocator, resolved_base.data, inflate_result.data);

            const hash = object.hashObject(resolved_base.obj_type, resolved);
            try resolved_by_offset.put(entry_offset, .{ .obj_type = resolved_base.obj_type, .data = resolved });
            try entries.append(allocator, .{ .obj_type = resolved_base.obj_type, .hash = hash, .data = resolved });
        } else {
            // Regular object
            const obj_type = try object.ObjectType.fromPackType(obj_type_raw);

            const inflate_result = try zlib.inflateWithSize(allocator, buf[offset..]);
            offset += inflate_result.compressed_size;

            const hash = object.hashObject(obj_type, inflate_result.data);
            try resolved_by_offset.put(entry_offset, .{ .obj_type = obj_type, .data = inflate_result.data });
            try entries.append(allocator, .{ .obj_type = obj_type, .hash = hash, .data = inflate_result.data });
        }
    }

    return entries.toOwnedSlice(allocator);
}

/// Build a pack file from a list of objects.
pub fn buildPack(allocator: std.mem.Allocator, objects: []const PackObject) ![]u8 {
    var output: std.ArrayList(u8) = .empty;
    errdefer output.deinit(allocator);

    // Header: "PACK" + version(2) + num_objects
    try output.appendSlice(allocator, "PACK");
    try output.appendSlice(allocator, &std.mem.toBytes(std.mem.nativeTo(u32, 2, .big)));
    try output.appendSlice(allocator, &std.mem.toBytes(std.mem.nativeTo(u32, @intCast(objects.len), .big)));

    for (objects) |obj| {
        const type_num = obj.obj_type.toPackType();
        const size = obj.data.len;

        // Encode type+size header
        var first_byte: u8 = (@as(u8, type_num) << 4) | @as(u8, @intCast(size & 0x0f));
        var remaining = size >> 4;
        if (remaining > 0) first_byte |= 0x80;
        try output.append(allocator, first_byte);

        while (remaining > 0) {
            var byte: u8 = @intCast(remaining & 0x7f);
            remaining >>= 7;
            if (remaining > 0) byte |= 0x80;
            try output.append(allocator, byte);
        }

        // Deflated data (fast level for pack building throughput)
        const compressed = try zlib.deflateFast(allocator, obj.data);
        defer allocator.free(compressed);
        try output.appendSlice(allocator, compressed);
    }

    // Trailing SHA-1 checksum
    const body = try output.toOwnedSlice(allocator);
    errdefer allocator.free(body);

    const checksum = sha1_mod.Sha1.hash(body);
    const result = try allocator.alloc(u8, body.len + 20);
    @memcpy(result[0..body.len], body);
    @memcpy(result[body.len..][0..20], &checksum);
    allocator.free(body);

    return result;
}

/// Build a pack file with OFS_DELTA compression.
/// Groups objects by type, then for each type tries to deltify objects against
/// their predecessor. This is a simplified version of git's delta selection —
/// real git uses a sliding window with size-based heuristics.
pub fn buildPackDelta(allocator: std.mem.Allocator, objects: []const PackObject) ![]u8 {
    if (objects.len == 0) return buildPack(allocator, objects);

    var output: std.ArrayList(u8) = .empty;
    errdefer output.deinit(allocator);

    // Header
    try output.appendSlice(allocator, "PACK");
    try output.appendSlice(allocator, &std.mem.toBytes(std.mem.nativeTo(u32, 2, .big)));
    try output.appendSlice(allocator, &std.mem.toBytes(std.mem.nativeTo(u32, @intCast(objects.len), .big)));

    // Track offsets for OFS_DELTA references
    var offsets = try allocator.alloc(usize, objects.len);
    defer allocator.free(offsets);

    for (objects, 0..) |obj, i| {
        offsets[i] = output.items.len;

        // Try delta against previous object of same type
        var use_delta = false;
        var delta_base_idx: usize = 0;
        var delta_data: ?[]u8 = null;

        if (i > 0 and obj.data.len >= 32) {
            // Look back through recent objects of same type
            var back: usize = 1;
            while (back <= @min(i, 10)) : (back += 1) {
                const prev = objects[i - back];
                if (prev.obj_type == obj.obj_type and prev.data.len >= 32) {
                    // Try creating a delta
                    const d = delta_mod.createDelta(allocator, prev.data, obj.data) catch continue;
                    // Only use delta if it's significantly smaller
                    if (d.len < obj.data.len * 3 / 4) {
                        if (delta_data) |old| allocator.free(old);
                        delta_data = d;
                        delta_base_idx = i - back;
                        use_delta = true;
                        break;
                    } else {
                        allocator.free(d);
                    }
                }
            }
        }

        if (use_delta) {
            const dd = delta_data.?;
            defer allocator.free(dd);

            // OFS_DELTA header
            const neg_offset = offsets[i] - offsets[delta_base_idx];

            // Type+size: type=6 (OFS_DELTA), size=delta uncompressed size
            var first_byte: u8 = (@as(u8, OBJ_OFS_DELTA) << 4) | @as(u8, @intCast(dd.len & 0x0f));
            var remaining = dd.len >> 4;
            if (remaining > 0) first_byte |= 0x80;
            try output.append(allocator, first_byte);
            while (remaining > 0) {
                var byte: u8 = @intCast(remaining & 0x7f);
                remaining >>= 7;
                if (remaining > 0) byte |= 0x80;
                try output.append(allocator, byte);
            }

            // Encode negative offset (variable-length, MSB encoding)
            var neg = neg_offset;
            var neg_bytes: [10]u8 = undefined;
            var neg_len: usize = 1;
            neg_bytes[0] = @intCast(neg & 0x7f);
            neg >>= 7;
            while (neg > 0) {
                neg -= 1;
                neg_bytes[neg_len] = @intCast(0x80 | (neg & 0x7f));
                neg >>= 7;
                neg_len += 1;
            }
            // Write in reverse order (MSB first)
            var j: usize = neg_len;
            while (j > 0) {
                j -= 1;
                try output.append(allocator, neg_bytes[j]);
            }

            // Compressed delta
            const compressed = try zlib.deflateFast(allocator, dd);
            defer allocator.free(compressed);
            try output.appendSlice(allocator, compressed);
        } else {
            if (delta_data) |d| allocator.free(d);

            // Regular non-delta object
            const type_num = obj.obj_type.toPackType();
            const size = obj.data.len;

            var first_byte: u8 = (@as(u8, type_num) << 4) | @as(u8, @intCast(size & 0x0f));
            var remaining = size >> 4;
            if (remaining > 0) first_byte |= 0x80;
            try output.append(allocator, first_byte);
            while (remaining > 0) {
                var byte: u8 = @intCast(remaining & 0x7f);
                remaining >>= 7;
                if (remaining > 0) byte |= 0x80;
                try output.append(allocator, byte);
            }

            const compressed = try zlib.deflateFast(allocator, obj.data);
            defer allocator.free(compressed);
            try output.appendSlice(allocator, compressed);
        }
    }

    // Trailing SHA-1 checksum
    const body = try output.toOwnedSlice(allocator);
    errdefer allocator.free(body);
    const checksum = sha1_mod.Sha1.hash(body);
    const result = try allocator.alloc(u8, body.len + 20);
    @memcpy(result[0..body.len], body);
    @memcpy(result[body.len..][0..20], &checksum);
    allocator.free(body);
    return result;
}

test "pack delta build and parse roundtrip" {
    const allocator = std.testing.allocator;

    // Create similar objects that should deltify well
    const objects = [_]PackObject{
        .{
            .obj_type = .blob,
            .hash = object.hashObject(.blob, "line1\nline2\nline3\nline4\nline5\nline6\n"),
            .data = "line1\nline2\nline3\nline4\nline5\nline6\n",
        },
        .{
            .obj_type = .blob,
            .hash = object.hashObject(.blob, "line1\nline2\nmodified\nline4\nline5\nline6\n"),
            .data = "line1\nline2\nmodified\nline4\nline5\nline6\n",
        },
    };

    const pack_data = try buildPackDelta(allocator, &objects);
    defer allocator.free(pack_data);

    const entries = try parsePack(allocator, pack_data);
    defer {
        for (entries) |*e| @constCast(e).deinit(allocator);
        allocator.free(entries);
    }

    try std.testing.expectEqual(@as(usize, 2), entries.len);
    try std.testing.expectEqualStrings("line1\nline2\nline3\nline4\nline5\nline6\n", entries[0].data);
    try std.testing.expectEqualStrings("line1\nline2\nmodified\nline4\nline5\nline6\n", entries[1].data);
}

test "pack build and parse roundtrip" {
    const allocator = std.testing.allocator;

    const objects = [_]PackObject{
        .{
            .obj_type = .blob,
            .hash = object.hashObject(.blob, "hello world\n"),
            .data = "hello world\n",
        },
        .{
            .obj_type = .blob,
            .hash = object.hashObject(.blob, "another file\n"),
            .data = "another file\n",
        },
    };

    const pack_data = try buildPack(allocator, &objects);
    defer allocator.free(pack_data);

    // Verify PACK header
    try std.testing.expectEqualStrings("PACK", pack_data[0..4]);

    const entries = try parsePack(allocator, pack_data);
    defer {
        for (entries) |*e| {
            @constCast(e).deinit(allocator);
        }
        allocator.free(entries);
    }

    try std.testing.expectEqual(@as(usize, 2), entries.len);
    try std.testing.expectEqualStrings("hello world\n", entries[0].data);
    try std.testing.expectEqualStrings("another file\n", entries[1].data);
}

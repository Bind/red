/// Pack index (.idx) v2 reader.
/// Provides O(log n) object lookup by SHA-1 hash in a pack file.
///
/// Index format (v2):
///   4 bytes: magic (\377tOc)
///   4 bytes: version (2)
///   256 * 4 bytes: fanout table (cumulative count of objects per first-byte hash)
///   N * 20 bytes: sorted SHA-1 hashes
///   N * 4 bytes: CRC32 checksums
///   N * 4 bytes: pack offsets (32-bit)
///   [optional] 8-byte offsets for large packs (>2GB)
///   20 bytes: pack checksum
///   20 bytes: index checksum
const std = @import("std");
const sha1_mod = @import("sha1.zig");

pub const PackIndex = struct {
    data: []const u8,
    count: u32,

    const HEADER_SIZE = 8;
    const FANOUT_SIZE = 256 * 4;
    const FANOUT_OFFSET = HEADER_SIZE;
    const HASH_OFFSET = HEADER_SIZE + FANOUT_SIZE;

    /// Parse a pack index from raw bytes. Does NOT take ownership of data.
    pub fn init(data: []const u8) !PackIndex {
        if (data.len < HEADER_SIZE + FANOUT_SIZE) return error.InvalidData;
        if (data[0] != 0xff or data[1] != 't' or data[2] != 'O' or data[3] != 'c') return error.InvalidData;
        if (std.mem.readInt(u32, data[4..8], .big) != 2) return error.InvalidData;

        const count = std.mem.readInt(u32, data[FANOUT_OFFSET + 255 * 4 ..][0..4], .big);

        // Validate minimum size: header + fanout + hashes + crc + offsets + checksums
        const min_size = HASH_OFFSET + @as(usize, count) * (20 + 4 + 4) + 40;
        if (data.len < min_size) return error.InvalidData;

        return .{ .data = data, .count = count };
    }

    /// Total number of objects in the pack.
    pub fn objectCount(self: PackIndex) u32 {
        return self.count;
    }

    /// Lookup an object by its 20-byte SHA-1 hash.
    /// Returns the pack file offset, or null if not found.
    pub fn lookup(self: PackIndex, hash: *const sha1_mod.Digest) ?u64 {
        const first_byte = hash[0];

        // Fanout gives range of entries with this first byte
        const lo_count = if (first_byte == 0) 0 else self.fanout(first_byte - 1);
        const hi_count = self.fanout(first_byte);
        if (lo_count >= hi_count) return null;

        // Binary search in the sorted hash range
        var lo: u32 = lo_count;
        var hi: u32 = hi_count;
        while (lo < hi) {
            const mid = lo + (hi - lo) / 2;
            const entry_hash = self.hashAt(mid);
            const cmp = std.mem.order(u8, hash, entry_hash);
            switch (cmp) {
                .eq => return self.offsetAt(mid),
                .lt => hi = mid,
                .gt => lo = mid + 1,
            }
        }
        return null;
    }

    /// Get the N-th hash from the sorted list (as a slice).
    pub fn hashAt(self: PackIndex, idx: u32) *const [20]u8 {
        const offset = HASH_OFFSET + @as(usize, idx) * 20;
        return self.data[offset..][0..20];
    }

    /// Get the pack offset for the N-th entry.
    pub fn offsetAt(self: PackIndex, idx: u32) u64 {
        const offset_table_start = HASH_OFFSET + @as(usize, self.count) * 20 + @as(usize, self.count) * 4;
        const off_pos = offset_table_start + @as(usize, idx) * 4;
        const raw = std.mem.readInt(u32, self.data[off_pos..][0..4], .big);

        if (raw & 0x80000000 != 0) {
            // Large offset — look in 8-byte table
            const large_idx: usize = raw & 0x7FFFFFFF;
            const large_table_start = offset_table_start + @as(usize, self.count) * 4;
            const large_pos = large_table_start + large_idx * 8;
            return std.mem.readInt(u64, self.data[large_pos..][0..8], .big);
        }
        return raw;
    }

    fn fanout(self: PackIndex, byte: u8) u32 {
        return std.mem.readInt(u32, self.data[FANOUT_OFFSET + @as(usize, byte) * 4 ..][0..4], .big);
    }

    /// Iterate all hashes in order.
    pub fn hashIterator(self: PackIndex) HashIterator {
        return .{ .index = self, .pos = 0 };
    }

    pub const HashIterator = struct {
        index: PackIndex,
        pos: u32,

        pub fn next(self: *HashIterator) ?*const [20]u8 {
            if (self.pos >= self.index.count) return null;
            const hash = self.index.hashAt(self.pos);
            self.pos += 1;
            return hash;
        }
    };
};

/// An entry for building a pack index.
pub const IndexEntry = struct {
    hash: sha1_mod.Digest,
    crc32: u32,
    offset: u64,
};

/// Build a v2 pack index from a list of entries and a pack checksum.
/// Entries are sorted by hash during construction.
/// Returns the complete .idx file content. Caller owns returned memory.
pub fn buildIndex(allocator: std.mem.Allocator, entries_in: []const IndexEntry, pack_checksum: sha1_mod.Digest) ![]u8 {
    // Copy and sort by hash
    const entries = try allocator.alloc(IndexEntry, entries_in.len);
    defer allocator.free(entries);
    @memcpy(entries, entries_in);
    std.mem.sort(IndexEntry, entries, {}, struct {
        fn cmp(_: void, a: IndexEntry, b_entry: IndexEntry) bool {
            return std.mem.order(u8, &a.hash, &b_entry.hash) == .lt;
        }
    }.cmp);

    const n: u32 = @intCast(entries.len);

    // Check if any offsets need 8-byte (large pack) encoding
    var large_offsets: u32 = 0;
    for (entries) |e| {
        if (e.offset >= 0x80000000) large_offsets += 1;
    }

    // Total size: header(8) + fanout(1024) + hashes(n*20) + crc(n*4) + offsets(n*4) + large(large*8) + checksums(40)
    const total_size = 8 + 1024 + @as(usize, n) * 20 + @as(usize, n) * 4 + @as(usize, n) * 4 + @as(usize, large_offsets) * 8 + 40;
    const data = try allocator.alloc(u8, total_size);
    errdefer allocator.free(data);

    var pos: usize = 0;

    // Magic + version
    data[0] = 0xff;
    data[1] = 't';
    data[2] = 'O';
    data[3] = 'c';
    std.mem.writeInt(u32, data[4..8], 2, .big);
    pos = 8;

    // Fanout table
    var fanout: [256]u32 = .{0} ** 256;
    for (entries) |e| {
        fanout[e.hash[0]] += 1;
    }
    // Make cumulative
    var cumulative: u32 = 0;
    for (0..256) |i| {
        cumulative += fanout[i];
        std.mem.writeInt(u32, data[pos..][0..4], cumulative, .big);
        pos += 4;
    }

    // Sorted hashes
    for (entries) |e| {
        @memcpy(data[pos..][0..20], &e.hash);
        pos += 20;
    }

    // CRC32 checksums
    for (entries) |e| {
        std.mem.writeInt(u32, data[pos..][0..4], e.crc32, .big);
        pos += 4;
    }

    // Pack offsets (4-byte, with MSB flag for large offsets)
    var large_idx: u32 = 0;
    for (entries) |e| {
        if (e.offset >= 0x80000000) {
            std.mem.writeInt(u32, data[pos..][0..4], 0x80000000 | large_idx, .big);
            large_idx += 1;
        } else {
            std.mem.writeInt(u32, data[pos..][0..4], @intCast(e.offset), .big);
        }
        pos += 4;
    }

    // Large offsets (8-byte)
    for (entries) |e| {
        if (e.offset >= 0x80000000) {
            std.mem.writeInt(u64, data[pos..][0..8], e.offset, .big);
            pos += 8;
        }
    }

    // Pack checksum
    @memcpy(data[pos..][0..20], &pack_checksum);
    pos += 20;

    // Index checksum (SHA-1 of everything before)
    const idx_checksum = sha1_mod.Sha1.hash(data[0..pos]);
    @memcpy(data[pos..][0..20], &idx_checksum);

    return data;
}

test "build and read index roundtrip" {
    const allocator = std.testing.allocator;

    var hash1: sha1_mod.Digest = undefined;
    @memset(&hash1, 0x11);
    var hash2: sha1_mod.Digest = undefined;
    @memset(&hash2, 0xAA);
    var hash3: sha1_mod.Digest = undefined;
    @memset(&hash3, 0x55);

    const entries = [_]IndexEntry{
        .{ .hash = hash1, .crc32 = 0, .offset = 12 },
        .{ .hash = hash2, .crc32 = 0, .offset = 100 },
        .{ .hash = hash3, .crc32 = 0, .offset = 200 },
    };
    var pack_cksum: sha1_mod.Digest = undefined;
    @memset(&pack_cksum, 0);

    const idx_data = try buildIndex(allocator, &entries, pack_cksum);
    defer allocator.free(idx_data);

    const idx = try PackIndex.init(idx_data);
    try std.testing.expectEqual(@as(u32, 3), idx.objectCount());

    // Lookup each hash
    try std.testing.expectEqual(@as(?u64, 12), idx.lookup(&hash1));
    try std.testing.expectEqual(@as(?u64, 200), idx.lookup(&hash3));
    try std.testing.expectEqual(@as(?u64, 100), idx.lookup(&hash2));

    // Missing
    var missing: sha1_mod.Digest = undefined;
    @memset(&missing, 0xFF);
    try std.testing.expectEqual(@as(?u64, null), idx.lookup(&missing));
}

test "pack index basic" {
    // Build a minimal v2 index with 1 object
    const allocator = std.testing.allocator;

    // header (8) + fanout (1024) + 1 hash (20) + 1 crc (4) + 1 offset (4) + checksums (40)
    const size = 8 + 1024 + 20 + 4 + 4 + 40;
    const data = try allocator.alloc(u8, size);
    defer allocator.free(data);
    @memset(data, 0);

    // Magic
    data[0] = 0xff;
    data[1] = 't';
    data[2] = 'O';
    data[3] = 'c';
    // Version 2
    std.mem.writeInt(u32, data[4..8], 2, .big);

    // Fanout: object has first byte 0xAB, so fanout[0xAB..0xFF] = 1
    for (0xAB..256) |i| {
        std.mem.writeInt(u32, data[8 + i * 4 ..][0..4], 1, .big);
    }

    // Hash at position 0
    const hash_offset = 8 + 1024;
    data[hash_offset] = 0xAB;
    @memset(data[hash_offset + 1 ..][0..19], 0xCD);

    // Offset at position 0: pack offset = 42
    const offset_pos = hash_offset + 20 + 4; // after hash + crc
    std.mem.writeInt(u32, data[offset_pos..][0..4], 42, .big);

    const idx = try PackIndex.init(data);
    try std.testing.expectEqual(@as(u32, 1), idx.objectCount());

    // Lookup the hash
    var lookup_hash: [20]u8 = undefined;
    lookup_hash[0] = 0xAB;
    @memset(lookup_hash[1..], 0xCD);
    const offset = idx.lookup(&lookup_hash);
    try std.testing.expectEqual(@as(?u64, 42), offset);

    // Lookup non-existent hash
    var missing: [20]u8 = undefined;
    @memset(&missing, 0xFF);
    try std.testing.expectEqual(@as(?u64, null), idx.lookup(&missing));
}

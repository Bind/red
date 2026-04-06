/// Pack file reader: resolves objects from a pack file using its index.
/// Handles OFS_DELTA and REF_DELTA chains with an LRU-style cache.
///
/// This is the hot path for serving git clone/fetch — every object lookup
/// goes through here. The resolve cache avoids re-decompressing shared
/// delta chain bases, critical for packs with depth-50 chains.
const std = @import("std");
const sha1_mod = @import("sha1.zig");
const zlib = @import("deflate.zig");
const object = @import("object.zig");
const delta_mod = @import("delta.zig");
const pack_index = @import("packindex.zig");

pub const OBJ_COMMIT: u3 = 1;
pub const OBJ_TREE: u3 = 2;
pub const OBJ_BLOB: u3 = 3;
pub const OBJ_TAG: u3 = 4;
pub const OBJ_OFS_DELTA: u3 = 6;
pub const OBJ_REF_DELTA: u3 = 7;

pub const ResolvedObject = struct {
    obj_type: object.ObjectType,
    data: []u8,

    pub fn deinit(self: *ResolvedObject, allocator: std.mem.Allocator) void {
        allocator.free(self.data);
    }
};

/// Bounded cache for resolved pack objects, keyed by pack offset.
/// Avoids re-decompressing shared delta chain bases.
/// Maximum 1024 entries (~20-30MB), matching ripgit's ResolveCache.
const ResolveCache = struct {
    const MAX_ENTRIES = 1024;
    const MAX_ENTRY_SIZE = 10_000_000; // 10MB — skip caching huge blobs

    entries: std.AutoHashMap(u64, CachedEntry),
    allocator: std.mem.Allocator,

    const CachedEntry = struct {
        obj_type: object.ObjectType,
        data: []u8,
    };

    fn init(allocator: std.mem.Allocator) ResolveCache {
        return .{
            .entries = std.AutoHashMap(u64, CachedEntry).init(allocator),
            .allocator = allocator,
        };
    }

    fn deinit(self: *ResolveCache) void {
        var iter = self.entries.valueIterator();
        while (iter.next()) |v| {
            self.allocator.free(v.data);
        }
        self.entries.deinit();
    }

    fn get(self: *ResolveCache, offset: u64) ?CachedEntry {
        return self.entries.get(offset);
    }

    fn tryPut(self: *ResolveCache, offset: u64, obj_type: object.ObjectType, data: []const u8) void {
        if (data.len > MAX_ENTRY_SIZE) return;
        if (self.entries.count() >= MAX_ENTRIES) return;
        const copy = self.allocator.alloc(u8, data.len) catch return;
        @memcpy(copy, data);
        self.entries.put(offset, .{ .obj_type = obj_type, .data = copy }) catch {
            self.allocator.free(copy);
        };
    }

    fn clear(self: *ResolveCache) void {
        var iter = self.entries.valueIterator();
        while (iter.next()) |v| {
            self.allocator.free(v.data);
        }
        self.entries.clearRetainingCapacity();
    }
};

/// Reads individual objects from a pack file by offset.
/// The pack data must remain valid for the lifetime of this reader.
pub const PackReader = struct {
    pack_data: []const u8,
    index: ?pack_index.PackIndex,
    allocator: std.mem.Allocator,
    cache: ResolveCache,

    pub fn init(allocator: std.mem.Allocator, pack_data: []const u8, index_data: ?[]const u8) !PackReader {
        const idx = if (index_data) |d| try pack_index.PackIndex.init(d) else null;
        return .{
            .pack_data = pack_data,
            .index = idx,
            .allocator = allocator,
            .cache = ResolveCache.init(allocator),
        };
    }

    pub fn deinit(self: *PackReader) void {
        self.cache.deinit();
    }

    /// Clear the resolve cache to free memory (e.g., after processing all commits,
    /// before processing blobs — like ripgit does).
    pub fn clearCache(self: *PackReader) void {
        self.cache.clear();
    }

    /// Look up an object by its SHA-1 hash. Returns null if not found.
    pub const ResolveError = error{
        DeltaChainTooDeep,
        InvalidOffset,
        DeltaBaseNotFound,
        InvalidData,
        InvalidObjectType,
        OutOfMemory,
        BaseSizeMismatch,
        ResultSizeMismatch,
    };

    pub fn getObject(self: *PackReader, hash: *const sha1_mod.Digest) ResolveError!?ResolvedObject {
        const idx = self.index orelse return null;
        const offset = idx.lookup(hash) orelse return null;
        return try self.resolveAtOffset(offset);
    }

    /// Resolve an object at a given byte offset in the pack file.
    pub fn resolveAtOffset(self: *PackReader, offset: u64) ResolveError!ResolvedObject {
        return self.resolveAtOffsetInner(offset, 0);
    }

    fn resolveAtOffsetInner(self: *PackReader, offset: u64, depth: usize) ResolveError!ResolvedObject {
        if (depth > 50) return error.DeltaChainTooDeep;
        if (offset >= self.pack_data.len) return error.InvalidOffset;

        // Check cache first
        if (self.cache.get(offset)) |cached| {
            const copy = try self.allocator.alloc(u8, cached.data.len);
            @memcpy(copy, cached.data);
            return .{ .obj_type = cached.obj_type, .data = copy };
        }

        var pos: usize = @intCast(offset);
        const data = self.pack_data;

        // Read type+size header
        var byte = data[pos];
        pos += 1;
        const type_raw: u3 = @intCast((byte >> 4) & 0x07);
        var shift: u6 = 4;
        while (byte & 0x80 != 0) {
            byte = data[pos];
            pos += 1;
            shift +|= 7;
        }

        if (type_raw == OBJ_OFS_DELTA) {
            var delta_byte = data[pos];
            pos += 1;
            var neg_offset: usize = delta_byte & 0x7f;
            while (delta_byte & 0x80 != 0) {
                delta_byte = data[pos];
                pos += 1;
                neg_offset = ((neg_offset + 1) << 7) | (delta_byte & 0x7f);
            }
            const base_offset = offset - neg_offset;

            const inflate_result = try zlib.inflateWithSize(self.allocator, data[pos..]);
            defer self.allocator.free(inflate_result.data);

            var base_obj = try self.resolveAtOffsetInner(base_offset, depth + 1);
            defer base_obj.deinit(self.allocator);

            const resolved = try delta_mod.applyDelta(self.allocator, base_obj.data, inflate_result.data);
            // Cache the resolved object
            self.cache.tryPut(offset, base_obj.obj_type, resolved);
            return .{ .obj_type = base_obj.obj_type, .data = resolved };
        } else if (type_raw == OBJ_REF_DELTA) {
            var base_hash: sha1_mod.Digest = undefined;
            @memcpy(&base_hash, data[pos..][0..20]);
            pos += 20;

            const inflate_result = try zlib.inflateWithSize(self.allocator, data[pos..]);
            defer self.allocator.free(inflate_result.data);

            var base_obj = try self.getObject(&base_hash) orelse return error.DeltaBaseNotFound;
            defer base_obj.deinit(self.allocator);

            const resolved = try delta_mod.applyDelta(self.allocator, base_obj.data, inflate_result.data);
            self.cache.tryPut(offset, base_obj.obj_type, resolved);
            return .{ .obj_type = base_obj.obj_type, .data = resolved };
        } else {
            const obj_type = try object.ObjectType.fromPackType(type_raw);
            const inflate_result = try zlib.inflateWithSize(self.allocator, data[pos..]);
            // Cache non-delta objects too (they're often delta bases)
            self.cache.tryPut(offset, obj_type, inflate_result.data);
            return .{ .obj_type = obj_type, .data = inflate_result.data };
        }
    }

    /// Get the total number of objects (requires index).
    pub fn objectCount(self: PackReader) ?u32 {
        return if (self.index) |idx| idx.objectCount() else null;
    }
};

// Tests for PackReader are in integration tests to avoid circular imports.

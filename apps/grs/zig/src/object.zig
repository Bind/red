/// Git object encoding, decoding, and hashing.
const std = @import("std");
const sha1 = @import("sha1.zig");
const zlib = @import("deflate.zig");

pub const ObjectType = enum {
    commit,
    tree,
    blob,
    tag,

    pub fn toString(self: ObjectType) []const u8 {
        return switch (self) {
            .commit => "commit",
            .tree => "tree",
            .blob => "blob",
            .tag => "tag",
        };
    }

    pub fn fromString(s: []const u8) !ObjectType {
        if (std.mem.eql(u8, s, "commit")) return .commit;
        if (std.mem.eql(u8, s, "tree")) return .tree;
        if (std.mem.eql(u8, s, "blob")) return .blob;
        if (std.mem.eql(u8, s, "tag")) return .tag;
        return error.InvalidObjectType;
    }

    pub fn fromPackType(t: u3) !ObjectType {
        return switch (t) {
            1 => .commit,
            2 => .tree,
            3 => .blob,
            4 => .tag,
            else => error.InvalidObjectType,
        };
    }

    pub fn toPackType(self: ObjectType) u3 {
        return switch (self) {
            .commit => 1,
            .tree => 2,
            .blob => 3,
            .tag => 4,
        };
    }
};

/// Hash a git object (type + data) and return the SHA-1 digest as hex.
pub fn hashObject(obj_type: ObjectType, data: []const u8) [40]u8 {
    const digest = hashObjectDigest(obj_type, data);
    return sha1.digestToHex(&digest);
}

/// Hash a git object and return the raw SHA-1 digest.
pub fn hashObjectDigest(obj_type: ObjectType, data: []const u8) sha1.Digest {
    var h = sha1.Sha1.init();
    // Single header buffer: "type len\0"
    var header_buf: [32]u8 = undefined;
    const header = std.fmt.bufPrint(&header_buf, "{s} {d}\x00", .{ obj_type.toString(), data.len }) catch unreachable;
    h.update(header);
    h.update(data);
    return h.final();
}

/// Encode a git object for storage (zlib-compressed "type len\0data").
/// Writes header and data directly to the compressor to avoid a copy.
pub fn encodeObject(allocator: std.mem.Allocator, obj_type: ObjectType, data: []const u8) ![]u8 {
    const flate = std.compress.flate;

    var aw: std.Io.Writer.Allocating = try .initCapacity(allocator, @max(data.len / 2, 64));
    errdefer aw.deinit();

    var comp_buf: [flate.max_window_len]u8 = undefined;
    var comp = flate.Compress.init(&aw.writer, &comp_buf, .zlib, .level_2) catch return error.OutOfMemory;

    // Write header directly to compressor
    var header_buf: [64]u8 = undefined;
    const header = std.fmt.bufPrint(&header_buf, "{s} {d}\x00", .{ obj_type.toString(), data.len }) catch unreachable;
    comp.writer.writeAll(header) catch return error.OutOfMemory;
    // Write data
    comp.writer.writeAll(data) catch return error.OutOfMemory;
    comp.finish() catch return error.OutOfMemory;

    return aw.toOwnedSlice();
}

/// Decode a stored git object (zlib-compressed).
pub fn decodeObject(allocator: std.mem.Allocator, raw: []const u8) !struct { obj_type: ObjectType, data: []u8 } {
    const inflated = try zlib.inflate(allocator, raw);
    errdefer allocator.free(inflated);

    // Find null separator
    const null_idx = std.mem.indexOfScalar(u8, inflated, 0) orelse return error.InvalidData;
    const header = inflated[0..null_idx];

    // Parse "type len"
    const space_idx = std.mem.indexOfScalar(u8, header, ' ') orelse return error.InvalidData;
    const obj_type = try ObjectType.fromString(header[0..space_idx]);

    // Data starts after null
    const data_start = null_idx + 1;
    const data = try allocator.alloc(u8, inflated.len - data_start);
    @memcpy(data, inflated[data_start..]);
    allocator.free(inflated);

    return .{ .obj_type = obj_type, .data = data };
}

// Tree entry for parsing/building trees
pub const TreeEntry = struct {
    mode: []const u8,
    name: []const u8,
    hash: sha1.Digest,
};

/// Parse tree object data into entries.
pub fn parseTree(allocator: std.mem.Allocator, data: []const u8) ![]TreeEntry {
    var entries: std.ArrayList(TreeEntry) = .empty;
    errdefer entries.deinit(allocator);

    var pos: usize = 0;
    while (pos < data.len) {
        // Find space (separates mode from name)
        const space_idx = std.mem.indexOfScalarPos(u8, data, pos, ' ') orelse return error.InvalidData;
        const mode = data[pos..space_idx];

        // Find null (separates name from hash)
        const null_idx = std.mem.indexOfScalarPos(u8, data, space_idx + 1, 0) orelse return error.InvalidData;
        const name = data[space_idx + 1 .. null_idx];

        // 20-byte hash follows null
        if (null_idx + 1 + 20 > data.len) return error.InvalidData;
        var hash: sha1.Digest = undefined;
        @memcpy(&hash, data[null_idx + 1 ..][0..20]);

        try entries.append(allocator, .{ .mode = mode, .name = name, .hash = hash });
        pos = null_idx + 21;
    }

    return entries.toOwnedSlice(allocator);
}

/// Parse commit object to extract tree hash and parent hashes.
pub const CommitInfo = struct {
    tree_hash: [40]u8,
    parents: []const [40]u8,
    author: []const u8,
    committer: []const u8,
    message: []const u8,
};

pub fn parseCommit(allocator: std.mem.Allocator, data: []const u8) !CommitInfo {
    var tree_hash: [40]u8 = undefined;
    var parents: std.ArrayList([40]u8) = .empty;
    errdefer parents.deinit(allocator);
    var author: []const u8 = "";
    var committer: []const u8 = "";

    var lines = std.mem.splitScalar(u8, data, '\n');
    var message_start: usize = 0;
    var line_end: usize = 0;

    while (lines.next()) |line| {
        line_end += line.len + 1;
        if (line.len == 0) {
            message_start = line_end;
            break;
        }
        if (std.mem.startsWith(u8, line, "tree ")) {
            @memcpy(&tree_hash, line[5..45]);
        } else if (std.mem.startsWith(u8, line, "parent ")) {
            var parent: [40]u8 = undefined;
            @memcpy(&parent, line[7..47]);
            try parents.append(allocator, parent);
        } else if (std.mem.startsWith(u8, line, "author ")) {
            author = line[7..];
        } else if (std.mem.startsWith(u8, line, "committer ")) {
            committer = line[10..];
        }
    }

    const message = if (message_start < data.len) data[message_start..] else "";

    return .{
        .tree_hash = tree_hash,
        .parents = try parents.toOwnedSlice(allocator),
        .author = author,
        .committer = committer,
        .message = message,
    };
}

/// Build a tree object's raw data from entries.
/// Entries must be sorted by name (git requirement).
pub fn buildTree(allocator: std.mem.Allocator, entries: []const TreeEntry) ![]u8 {
    // Calculate total size
    var total: usize = 0;
    for (entries) |e| {
        total += e.mode.len + 1 + e.name.len + 1 + 20; // "mode name\0<20-byte-hash>"
    }

    const data = try allocator.alloc(u8, total);
    errdefer allocator.free(data);
    var pos: usize = 0;

    for (entries) |e| {
        @memcpy(data[pos..][0..e.mode.len], e.mode);
        pos += e.mode.len;
        data[pos] = ' ';
        pos += 1;
        @memcpy(data[pos..][0..e.name.len], e.name);
        pos += e.name.len;
        data[pos] = 0;
        pos += 1;
        @memcpy(data[pos..][0..20], &e.hash);
        pos += 20;
    }

    return data;
}

/// Build a commit object's raw data.
pub fn buildCommit(
    allocator: std.mem.Allocator,
    tree_hash: [40]u8,
    parents: []const [40]u8,
    author: []const u8,
    committer: []const u8,
    message: []const u8,
) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);

    // tree <hash>\n
    try out.appendSlice(allocator, "tree ");
    try out.appendSlice(allocator, &tree_hash);
    try out.append(allocator, '\n');

    // parent <hash>\n (zero or more)
    for (parents) |p| {
        try out.appendSlice(allocator, "parent ");
        try out.appendSlice(allocator, &p);
        try out.append(allocator, '\n');
    }

    // author ...\n
    try out.appendSlice(allocator, "author ");
    try out.appendSlice(allocator, author);
    try out.append(allocator, '\n');

    // committer ...\n
    try out.appendSlice(allocator, "committer ");
    try out.appendSlice(allocator, committer);
    try out.append(allocator, '\n');

    // blank line + message
    try out.append(allocator, '\n');
    try out.appendSlice(allocator, message);

    return out.toOwnedSlice(allocator);
}

/// Build a tag object's raw data.
pub fn buildTag(
    allocator: std.mem.Allocator,
    object_hash: [40]u8,
    object_type: ObjectType,
    tag_name: []const u8,
    tagger: []const u8,
    message: []const u8,
) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);

    try out.appendSlice(allocator, "object ");
    try out.appendSlice(allocator, &object_hash);
    try out.append(allocator, '\n');

    try out.appendSlice(allocator, "type ");
    try out.appendSlice(allocator, object_type.toString());
    try out.append(allocator, '\n');

    try out.appendSlice(allocator, "tag ");
    try out.appendSlice(allocator, tag_name);
    try out.append(allocator, '\n');

    try out.appendSlice(allocator, "tagger ");
    try out.appendSlice(allocator, tagger);
    try out.append(allocator, '\n');

    try out.append(allocator, '\n');
    try out.appendSlice(allocator, message);

    return out.toOwnedSlice(allocator);
}

/// Parse a tag object.
pub const TagInfo = struct {
    object_hash: [40]u8,
    object_type: []const u8,
    tag_name: []const u8,
    tagger: []const u8,
    message: []const u8,
};

pub fn parseTag(data: []const u8) TagInfo {
    var object_hash: [40]u8 = undefined;
    var object_type: []const u8 = "";
    var tag_name: []const u8 = "";
    var tagger: []const u8 = "";

    var lines = std.mem.splitScalar(u8, data, '\n');
    var message_start: usize = 0;
    var line_end: usize = 0;

    while (lines.next()) |line| {
        line_end += line.len + 1;
        if (line.len == 0) {
            message_start = line_end;
            break;
        }
        if (std.mem.startsWith(u8, line, "object ") and line.len >= 47) {
            @memcpy(&object_hash, line[7..47]);
        } else if (std.mem.startsWith(u8, line, "type ")) {
            object_type = line[5..];
        } else if (std.mem.startsWith(u8, line, "tag ")) {
            tag_name = line[4..];
        } else if (std.mem.startsWith(u8, line, "tagger ")) {
            tagger = line[7..];
        }
    }

    const message = if (message_start < data.len) data[message_start..] else "";

    return .{
        .object_hash = object_hash,
        .object_type = object_type,
        .tag_name = tag_name,
        .tagger = tagger,
        .message = message,
    };
}

test "hash blob object" {
    // "hello\n" should produce a known SHA-1
    const hex = hashObject(.blob, "hello\n");
    try std.testing.expectEqualStrings("ce013625030ba8dba906f756967f9e9ca394464a", &hex);
}

test "encode decode roundtrip" {
    const allocator = std.testing.allocator;
    const data = "Hello, world!\n";

    const encoded = try encodeObject(allocator, .blob, data);
    defer allocator.free(encoded);

    const decoded = try decodeObject(allocator, encoded);
    defer allocator.free(decoded.data);

    try std.testing.expectEqual(ObjectType.blob, decoded.obj_type);
    try std.testing.expectEqualStrings(data, decoded.data);
}

test "build and parse tree roundtrip" {
    const allocator = std.testing.allocator;
    const blob_hash = sha1.Sha1.hash("test blob");

    const entries = [_]TreeEntry{
        .{ .mode = "100644", .name = "hello.txt", .hash = blob_hash },
        .{ .mode = "40000", .name = "src", .hash = blob_hash },
    };

    const tree_data = try buildTree(allocator, &entries);
    defer allocator.free(tree_data);

    const parsed = try parseTree(allocator, tree_data);
    defer allocator.free(parsed);

    try std.testing.expectEqual(@as(usize, 2), parsed.len);
    try std.testing.expectEqualStrings("hello.txt", parsed[0].name);
    try std.testing.expectEqualStrings("100644", parsed[0].mode);
    try std.testing.expectEqualStrings("src", parsed[1].name);
}

test "build and parse commit roundtrip" {
    const allocator = std.testing.allocator;
    const tree_hash: [40]u8 = .{'a'} ** 40;
    const parent: [40]u8 = .{'b'} ** 40;

    const commit_data = try buildCommit(
        allocator,
        tree_hash,
        &[_][40]u8{parent},
        "Test User <test@example.com> 1700000000 +0000",
        "Test User <test@example.com> 1700000000 +0000",
        "Initial commit\n",
    );
    defer allocator.free(commit_data);

    const parsed = try parseCommit(allocator, commit_data);
    defer allocator.free(parsed.parents);

    try std.testing.expectEqualStrings("a" ** 40, &parsed.tree_hash);
    try std.testing.expectEqual(@as(usize, 1), parsed.parents.len);
    try std.testing.expectEqualStrings("b" ** 40, &parsed.parents[0]);
    try std.testing.expectEqualStrings("Initial commit\n", parsed.message);
}

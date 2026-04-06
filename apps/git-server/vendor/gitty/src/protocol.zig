/// Git smart HTTP protocol implementation.
/// Handles pkt-line encoding, ref advertisement, receive-pack, and upload-pack.
const std = @import("std");
const sha1_mod = @import("sha1.zig");
const object = @import("object.zig");
const pack_mod = @import("pack.zig");
const zlib = @import("deflate.zig");

const ZERO_HASH = "0000000000000000000000000000000000000000";

// ---- pkt-line encoding ----

/// Write a pkt-line formatted string.
pub fn pktLine(allocator: std.mem.Allocator, data: []const u8) ![]u8 {
    const len = 4 + data.len;
    const result = try allocator.alloc(u8, len);
    _ = std.fmt.bufPrint(result[0..4], "{x:0>4}", .{len}) catch unreachable;
    @memcpy(result[4..], data);
    return result;
}

/// Flush packet "0000"
pub const FLUSH = "0000";

/// Write a pkt-line directly to an ArrayList without a separate allocation.
pub fn pktLineAppend(allocator: std.mem.Allocator, out: *std.ArrayList(u8), data: []const u8) !void {
    const len = 4 + data.len;
    var header: [4]u8 = undefined;
    _ = std.fmt.bufPrint(&header, "{x:0>4}", .{len}) catch unreachable;
    try out.appendSlice(allocator, &header);
    try out.appendSlice(allocator, data);
}

/// Side-band channel IDs for multiplexed pack data.
pub const SideBand = enum(u8) {
    pack_data = 1, // Pack file data
    progress = 2, // Progress messages (stderr on client)
    error_msg = 3, // Error messages

    /// Wrap data in a side-band pkt-line.
    pub fn wrap(allocator: std.mem.Allocator, channel: SideBand, data: []const u8) ![]u8 {
        const len = 4 + 1 + data.len; // pkt-len + channel byte + data
        const result = try allocator.alloc(u8, len);
        _ = std.fmt.bufPrint(result[0..4], "{x:0>4}", .{len}) catch unreachable;
        result[4] = @intFromEnum(channel);
        @memcpy(result[5..], data);
        return result;
    }

    /// Append side-band wrapped data to an ArrayList.
    pub fn appendTo(allocator: std.mem.Allocator, out: *std.ArrayList(u8), channel: SideBand, data: []const u8) !void {
        const len = 4 + 1 + data.len;
        var header: [5]u8 = undefined;
        _ = std.fmt.bufPrint(header[0..4], "{x:0>4}", .{len}) catch unreachable;
        header[4] = @intFromEnum(channel);
        try out.appendSlice(allocator, &header);
        try out.appendSlice(allocator, data);
    }
};

// ---- Capabilities ----

/// Server capabilities advertised during ref discovery.
/// Capabilities we actually implement.
pub const SERVER_CAPS = "report-status delete-refs ofs-delta side-band-64k symref=HEAD:refs/heads/main";

/// Parse capabilities from a NUL-separated string (sent by client after first want/command).
pub fn parseCapabilities(caps_str: []const u8) Capabilities {
    var caps = Capabilities{};
    var iter = std.mem.splitScalar(u8, caps_str, ' ');
    while (iter.next()) |cap| {
        if (std.mem.eql(u8, cap, "report-status")) caps.report_status = true;
        if (std.mem.eql(u8, cap, "side-band-64k")) caps.side_band_64k = true;
        if (std.mem.eql(u8, cap, "side-band")) caps.side_band = true;
        if (std.mem.eql(u8, cap, "ofs-delta")) caps.ofs_delta = true;
        if (std.mem.eql(u8, cap, "thin-pack")) caps.thin_pack = true;
        if (std.mem.eql(u8, cap, "no-done")) caps.no_done = true;
        if (std.mem.eql(u8, cap, "delete-refs")) caps.delete_refs = true;
        if (std.mem.eql(u8, cap, "multi_ack")) caps.multi_ack = true;
        if (std.mem.eql(u8, cap, "multi_ack_detailed")) caps.multi_ack_detailed = true;
        if (std.mem.eql(u8, cap, "no-progress")) caps.no_progress = true;
        if (std.mem.eql(u8, cap, "include-tag")) caps.include_tag = true;
    }
    return caps;
}

pub const Capabilities = struct {
    report_status: bool = false,
    side_band_64k: bool = false,
    side_band: bool = false,
    ofs_delta: bool = false,
    thin_pack: bool = false,
    no_done: bool = false,
    delete_refs: bool = false,
    multi_ack: bool = false,
    multi_ack_detailed: bool = false,
    no_progress: bool = false,
    include_tag: bool = false,
};

/// Resolve a ref name to a commit hash, trying multiple forms:
///   1. Exact match (e.g., "refs/heads/main")
///   2. "refs/heads/<name>" (branch shorthand)
///   3. "refs/tags/<name>" (tag shorthand)
/// For symbolic refs like HEAD, the caller should read the symref first
/// (e.g., "ref: refs/heads/main" -> follow to "refs/heads/main").
pub fn resolveRef(allocator: std.mem.Allocator, storage: StorageAdapter, name: []const u8) !?[]u8 {
    // Try exact
    if (try storage.getRef(allocator, name)) |h| return h;

    // Try refs/heads/<name>
    var buf: [256]u8 = undefined;
    const branch = std.fmt.bufPrint(&buf, "refs/heads/{s}", .{name}) catch return null;
    if (try storage.getRef(allocator, branch)) |h| return h;

    // Try refs/tags/<name>
    const tag = std.fmt.bufPrint(&buf, "refs/tags/{s}", .{name}) catch return null;
    if (try storage.getRef(allocator, tag)) |h| return h;

    return null;
}

/// Parse a symbolic ref value (e.g., "ref: refs/heads/main\n" -> "refs/heads/main").
pub fn parseSymbolicRef(data: []const u8) ?[]const u8 {
    const trimmed = std.mem.trimEnd(u8, data, &[_]u8{ '\n', '\r', ' ' });
    if (std.mem.startsWith(u8, trimmed, "ref: ")) {
        return trimmed[5..];
    }
    return null;
}

// ---- Ref command parsing ----

pub const RefCommand = struct {
    old_hash: [40]u8,
    new_hash: [40]u8,
    ref_name: []const u8,
};

pub const ParsedCommands = struct {
    commands: []RefCommand,
    pack_offset: usize,
    capabilities: Capabilities,
};

/// Parse pkt-line ref update commands from a receive-pack body.
pub fn parseRefCommands(allocator: std.mem.Allocator, body: []const u8) !ParsedCommands {
    var commands: std.ArrayList(RefCommand) = .empty;
    errdefer commands.deinit(allocator);
    var offset: usize = 0;
    var caps = Capabilities{};

    while (offset + 4 <= body.len) {
        const len_hex = body[offset..][0..4];
        if (std.mem.eql(u8, len_hex, "0000")) {
            offset += 4;
            break;
        }
        const len = std.fmt.parseInt(usize, len_hex, 16) catch break;
        if (len == 0) break;
        if (offset + len > body.len) break;

        const line_data = body[offset + 4 .. offset + len];
        offset += len;

        // Trim trailing newline/whitespace
        var line = std.mem.trimEnd(u8, line_data, &[_]u8{ '\n', '\r', ' ' });

        // Extract capabilities from first line (after \0)
        if (std.mem.indexOfScalar(u8, line, 0)) |null_idx| {
            if (null_idx + 1 < line.len) {
                const caps_str = std.mem.trimStart(u8, line[null_idx + 1 ..], &[_]u8{' '});
                caps = parseCapabilities(caps_str);
            }
            line = line[0..null_idx];
        }

        // Format: <old-hash> <new-hash> <ref-name>
        var parts = std.mem.splitScalar(u8, line, ' ');
        const old_hash_str = parts.next() orelse continue;
        const new_hash_str = parts.next() orelse continue;
        const ref_name = parts.next() orelse continue;

        if (old_hash_str.len != 40 or new_hash_str.len != 40) continue;

        var cmd: RefCommand = undefined;
        @memcpy(&cmd.old_hash, old_hash_str);
        @memcpy(&cmd.new_hash, new_hash_str);
        cmd.ref_name = ref_name;

        try commands.append(allocator, cmd);
    }

    return .{
        .commands = try commands.toOwnedSlice(allocator),
        .pack_offset = offset,
        .capabilities = caps,
    };
}

// ---- Storage interface ----

pub const Ref = struct {
    name: []const u8,
    hash: []const u8,
};

/// Storage adapter interface for the protocol layer.
pub const StorageAdapter = struct {
    ptr: *anyopaque,
    vtable: *const VTable,

    pub const VTable = struct {
        getObject: *const fn (ptr: *anyopaque, allocator: std.mem.Allocator, hash: []const u8) anyerror!?[]u8,
        putObject: *const fn (ptr: *anyopaque, hash: []const u8, data: []const u8) anyerror!void,
        getRef: *const fn (ptr: *anyopaque, allocator: std.mem.Allocator, name: []const u8) anyerror!?[]u8,
        setRef: *const fn (ptr: *anyopaque, name: []const u8, hash: []const u8) anyerror!void,
        deleteRef: *const fn (ptr: *anyopaque, name: []const u8) anyerror!void,
        listRefs: *const fn (ptr: *anyopaque, allocator: std.mem.Allocator) anyerror![]Ref,
    };

    pub fn getObject(self: StorageAdapter, allocator: std.mem.Allocator, hash: []const u8) !?[]u8 {
        return self.vtable.getObject(self.ptr, allocator, hash);
    }
    pub fn putObject(self: StorageAdapter, hash: []const u8, data: []const u8) !void {
        return self.vtable.putObject(self.ptr, hash, data);
    }
    pub fn getRef(self: StorageAdapter, allocator: std.mem.Allocator, name: []const u8) !?[]u8 {
        return self.vtable.getRef(self.ptr, allocator, name);
    }
    pub fn setRef(self: StorageAdapter, name: []const u8, hash: []const u8) !void {
        return self.vtable.setRef(self.ptr, name, hash);
    }
    pub fn deleteRef(self: StorageAdapter, name: []const u8) !void {
        return self.vtable.deleteRef(self.ptr, name);
    }
    pub fn listRefs(self: StorageAdapter, allocator: std.mem.Allocator) ![]Ref {
        return self.vtable.listRefs(self.ptr, allocator);
    }
};

// ---- Protocol handlers ----

/// Handle git-receive-pack (git push).
pub fn handleReceivePack(allocator: std.mem.Allocator, storage: StorageAdapter, body: []const u8) ![]u8 {
    const parsed = try parseRefCommands(allocator, body);
    defer allocator.free(parsed.commands);

    if (parsed.commands.len == 0) {
        return try allocator.alloc(u8, 0);
    }

    // Parse and store pack data
    if (parsed.pack_offset < body.len) {
        const pack_data = body[parsed.pack_offset..];
        const entries = try pack_mod.parsePackWithExternalBases(allocator, pack_data, .{
            .ctx = @ptrCast(&storage),
            .resolve = struct {
                fn resolve(
                    ctx: *const anyopaque,
                    inner_allocator: std.mem.Allocator,
                    hash: []const u8,
                ) anyerror!?pack_mod.ResolvedBaseObject {
                    const storage_ptr: *const StorageAdapter = @ptrCast(@alignCast(ctx));
                    const raw = try storage_ptr.*.getObject(inner_allocator, hash) orelse return null;
                    defer inner_allocator.free(raw);

                    const decoded = try object.decodeObject(inner_allocator, raw);
                    return .{
                        .obj_type = decoded.obj_type,
                        .data = decoded.data,
                    };
                }
            }.resolve,
        });
        defer {
            for (entries) |*e| {
                @constCast(e).deinit(allocator);
            }
            allocator.free(entries);
        }

        for (entries) |entry| {
            const encoded = try object.encodeObject(allocator, entry.obj_type, entry.data);
            defer allocator.free(encoded);
            try storage.putObject(&entry.hash, encoded);
        }
    }

    // Update refs
    for (parsed.commands) |cmd| {
        if (std.mem.eql(u8, &cmd.new_hash, ZERO_HASH)) {
            try storage.deleteRef(cmd.ref_name);
        } else {
            try storage.setRef(cmd.ref_name, &cmd.new_hash);
        }
    }

    // Build report-status response
    var status_buf: std.ArrayList(u8) = .empty;
    defer status_buf.deinit(allocator);

    try pktLineAppend(allocator, &status_buf, "unpack ok\n");
    for (parsed.commands) |cmd| {
        var ref_buf: [256]u8 = undefined;
        const ref_line = std.fmt.bufPrint(&ref_buf, "ok {s}\n", .{cmd.ref_name}) catch continue;
        try pktLineAppend(allocator, &status_buf, ref_line);
    }
    try status_buf.appendSlice(allocator, FLUSH);

    // Wrap in side-band-64k if client requested it
    if (parsed.capabilities.side_band_64k) {
        return wrapSideBand(allocator, status_buf.items);
    }

    return status_buf.toOwnedSlice(allocator);
}

/// Wrap report-status data in side-band-64k pkt-line framing.
/// Channel 1 = pack data/status, channel 2 = progress. Terminates with flush.
fn wrapSideBand(allocator: std.mem.Allocator, data: []const u8) ![]u8 {
    var output: std.ArrayList(u8) = .empty;
    errdefer output.deinit(allocator);

    // Send data on channel 1, max 65515 bytes per packet (65520 - 4 len - 1 channel)
    const MAX_CHUNK = 65515;
    var pos: usize = 0;
    while (pos < data.len) {
        const chunk_len = @min(data.len - pos, MAX_CHUNK);
        try SideBand.appendTo(allocator, &output, .pack_data, data[pos..][0..chunk_len]);
        pos += chunk_len;
    }
    try output.appendSlice(allocator, FLUSH);
    return output.toOwnedSlice(allocator);
}

/// Handle ref advertisement (info/refs endpoint).
/// Options for ref advertisement.
pub const AdvertiseOptions = struct {
    /// Default branch (used for HEAD symref). Defaults to "refs/heads/main".
    default_branch: []const u8 = "refs/heads/main",
};

/// Handle ref advertisement (info/refs endpoint).
/// Supports configurable default branch via options.
pub fn advertiseRefs(allocator: std.mem.Allocator, storage: StorageAdapter, service: []const u8) ![]u8 {
    return advertiseRefsWithOptions(allocator, storage, service, .{});
}

pub fn advertiseRefsWithOptions(allocator: std.mem.Allocator, storage: StorageAdapter, service: []const u8, options: AdvertiseOptions) ![]u8 {
    var output: std.ArrayList(u8) = .empty;
    errdefer output.deinit(allocator);

    // Service announcement
    var svc_buf: [128]u8 = undefined;
    const svc_line = std.fmt.bufPrint(&svc_buf, "# service={s}\n", .{service}) catch unreachable;
    const svc_pkt = try pktLine(allocator, svc_line);
    defer allocator.free(svc_pkt);
    try output.appendSlice(allocator, svc_pkt);
    try output.appendSlice(allocator, FLUSH);

    var caps_buf: [256]u8 = undefined;
    const caps = std.fmt.bufPrint(&caps_buf, "report-status delete-refs ofs-delta side-band-64k symref=HEAD:{s}", .{options.default_branch}) catch unreachable;

    const refs = try storage.listRefs(allocator);
    defer allocator.free(refs);

    if (refs.len == 0) {
        var cap_buf: [512]u8 = undefined;
        const cap_line = std.fmt.bufPrint(&cap_buf, "{s} capabilities^{{}}\x00{s}\n", .{ ZERO_HASH, caps }) catch unreachable;
        const pkt = try pktLine(allocator, cap_line);
        defer allocator.free(pkt);
        try output.appendSlice(allocator, pkt);
    } else {
        var main_hash: ?[]const u8 = null;
        for (refs) |ref| {
            if (std.mem.eql(u8, ref.name, options.default_branch)) {
                main_hash = ref.hash;
                break;
            }
        }

        var first = true;
        if (main_hash) |mh| {
            var head_buf: [256]u8 = undefined;
            const head_line = std.fmt.bufPrint(&head_buf, "{s} HEAD\x00{s}\n", .{ mh, caps }) catch unreachable;
            const pkt = try pktLine(allocator, head_line);
            defer allocator.free(pkt);
            try output.appendSlice(allocator, pkt);
            first = false;
        }

        for (refs) |ref| {
            if (first) {
                var ref_buf: [512]u8 = undefined;
                const ref_line = std.fmt.bufPrint(&ref_buf, "{s} {s}\x00{s}\n", .{ ref.hash, ref.name, caps }) catch unreachable;
                const pkt = try pktLine(allocator, ref_line);
                defer allocator.free(pkt);
                try output.appendSlice(allocator, pkt);
                first = false;
            } else {
                var ref_buf: [512]u8 = undefined;
                const ref_line = std.fmt.bufPrint(&ref_buf, "{s} {s}\n", .{ ref.hash, ref.name }) catch unreachable;
                const pkt = try pktLine(allocator, ref_line);
                defer allocator.free(pkt);
                try output.appendSlice(allocator, pkt);
            }
        }
    }

    try output.appendSlice(allocator, FLUSH);
    return output.toOwnedSlice(allocator);
}

/// Handle git-upload-pack (git fetch/clone).
pub fn handleUploadPack(allocator: std.mem.Allocator, storage: StorageAdapter, body: []const u8) ![]u8 {
    // Parse want/have lines and capabilities
    var wants: std.ArrayList([40]u8) = .empty;
    defer wants.deinit(allocator);
    var haves = std.AutoHashMap([40]u8, void).init(allocator);
    defer haves.deinit();
    var caps = Capabilities{};
    var first_want = true;

    var offset: usize = 0;
    while (offset + 4 <= body.len) {
        const len_hex = body[offset..][0..4];
        if (std.mem.eql(u8, len_hex, "0000")) {
            offset += 4;
            continue;
        }
        if (std.mem.eql(u8, len_hex, "0009")) {
            offset += 9;
            break;
        }
        const len = std.fmt.parseInt(usize, len_hex, 16) catch break;
        if (len == 0) break;
        if (offset + len > body.len) break;

        var line = std.mem.trimEnd(u8, body[offset + 4 .. offset + len], &[_]u8{ '\n', '\r', ' ' });
        offset += len;

        if (std.mem.startsWith(u8, line, "want ")) {
            var rest = line[5..];
            // First want line may have capabilities after NUL or after hash+space
            if (first_want) {
                first_want = false;
                if (std.mem.indexOfScalar(u8, rest, 0)) |null_idx| {
                    if (null_idx + 1 < rest.len) {
                        caps = parseCapabilities(std.mem.trimStart(u8, rest[null_idx + 1 ..], &[_]u8{' '}));
                    }
                    rest = rest[0..null_idx];
                } else if (rest.len > 40) {
                    // Capabilities after space: "want <hash> cap1 cap2..."
                    caps = parseCapabilities(std.mem.trimStart(u8, rest[40..], &[_]u8{' '}));
                    rest = rest[0..40];
                }
            }
            const hash_end = @min(rest.len, 40);
            if (hash_end == 40) {
                var hash: [40]u8 = undefined;
                @memcpy(&hash, rest[0..40]);
                try wants.append(allocator, hash);
            }
        } else if (std.mem.startsWith(u8, line, "have ")) {
            const rest = line[5..];
            const hash_end = @min(rest.len, 40);
            if (hash_end == 40) {
                var have_hash: [40]u8 = undefined;
                @memcpy(&have_hash, rest[0..40]);
                try haves.put(have_hash, {});
            }
        }
    }

    if (wants.items.len == 0) {
        const nak = try pktLine(allocator, "NAK\n");
        defer allocator.free(nak);
        var output: std.ArrayList(u8) = .empty;
        errdefer output.deinit(allocator);
        try output.appendSlice(allocator, nak);
        try output.appendSlice(allocator, FLUSH);
        return output.toOwnedSlice(allocator);
    }

    // BFS to collect all needed objects
    var needed = std.AutoHashMap([40]u8, void).init(allocator);
    defer needed.deinit();

    var queue: std.ArrayList([40]u8) = .empty;
    defer queue.deinit(allocator);

    for (wants.items) |want| {
        try queue.append(allocator, want);
    }

    const CollectedObj = struct { obj_type: object.ObjectType, hash: [40]u8, data: []u8 };
    var collected_objects: std.ArrayList(CollectedObj) = .empty;
    defer {
        for (collected_objects.items) |item| allocator.free(item.data);
        collected_objects.deinit(allocator);
    }

    while (queue.items.len > 0) {
        const hash = queue.pop() orelse break;
        if (needed.contains(hash)) continue;
        if (haves.contains(hash)) continue;
        try needed.put(hash, {});

        const raw = try storage.getObject(allocator, &hash) orelse continue;
        defer allocator.free(raw);

        const obj = try object.decodeObject(allocator, raw);

        try collected_objects.append(allocator, .{
            .obj_type = obj.obj_type,
            .hash = hash,
            .data = obj.data,
        });

        if (obj.obj_type == .commit) {
            var lines = std.mem.splitScalar(u8, obj.data, '\n');
            while (lines.next()) |l| {
                if (l.len == 0) break;
                if (std.mem.startsWith(u8, l, "tree ") and l.len >= 45) {
                    var tree_hash: [40]u8 = undefined;
                    @memcpy(&tree_hash, l[5..45]);
                    try queue.append(allocator, tree_hash);
                } else if (std.mem.startsWith(u8, l, "parent ") and l.len >= 47) {
                    var parent_hash: [40]u8 = undefined;
                    @memcpy(&parent_hash, l[7..47]);
                    try queue.append(allocator, parent_hash);
                }
            }
        } else if (obj.obj_type == .tree) {
            var pos: usize = 0;
            while (pos < obj.data.len) {
                const space_idx = std.mem.indexOfScalarPos(u8, obj.data, pos, ' ') orelse break;
                const null_idx = std.mem.indexOfScalarPos(u8, obj.data, space_idx + 1, 0) orelse break;
                if (null_idx + 21 > obj.data.len) break;
                var entry_hash_bytes: [20]u8 = undefined;
                @memcpy(&entry_hash_bytes, obj.data[null_idx + 1 ..][0..20]);
                const entry_hash = sha1_mod.digestToHex(&entry_hash_bytes);
                try queue.append(allocator, entry_hash);
                pos = null_idx + 21;
            }
        }
    }

    // Build pack
    const pack_objects = try allocator.alloc(pack_mod.PackObject, collected_objects.items.len);
    defer allocator.free(pack_objects);

    for (collected_objects.items, 0..) |item, i| {
        pack_objects[i] = .{
            .obj_type = item.obj_type,
            .hash = item.hash,
            .data = item.data,
        };
    }

    const pack_data = try pack_mod.buildPack(allocator, pack_objects);
    defer allocator.free(pack_data);

    // Response: ACK (if common commits) or NAK, then pack data
    var output: std.ArrayList(u8) = .empty;
    errdefer output.deinit(allocator);

    // Check if any have lines match objects we have — send ACK for common base
    var acked = false;
    var have_iter = haves.keyIterator();
    while (have_iter.next()) |have_hash_ptr| {
        if (try storage.getObject(allocator, have_hash_ptr)) |obj_data| {
            allocator.free(obj_data);
            var ack_buf: [64]u8 = undefined;
            const ack_line = std.fmt.bufPrint(&ack_buf, "ACK {s}\n", .{have_hash_ptr}) catch continue;
            try pktLineAppend(allocator, &output, ack_line);
            acked = true;
            break;
        }
    }

    if (!acked) {
        try pktLineAppend(allocator, &output, "NAK\n");
    }

    // Wrap pack data in side-band-64k if client requested it
    if (caps.side_band_64k) {
        // Send pack data on channel 1 in chunks
        const MAX_SB_CHUNK = 65515;
        var pos: usize = 0;
        while (pos < pack_data.len) {
            const chunk_len = @min(pack_data.len - pos, MAX_SB_CHUNK);
            try SideBand.appendTo(allocator, &output, .pack_data, pack_data[pos..][0..chunk_len]);
            pos += chunk_len;
        }
        try output.appendSlice(allocator, FLUSH);
    } else {
        try output.appendSlice(allocator, pack_data);
    }

    return output.toOwnedSlice(allocator);
}

test "pkt-line encoding" {
    const allocator = std.testing.allocator;
    const line = try pktLine(allocator, "# service=git-upload-pack\n");
    defer allocator.free(line);
    try std.testing.expectEqualStrings("001e# service=git-upload-pack\n", line);
}

test "parse ref commands" {
    const allocator = std.testing.allocator;
    const old_hash = ZERO_HASH;
    const new_hash = "a" ** 40;
    var body_buf: [256]u8 = undefined;
    const cmd_str = std.fmt.bufPrint(&body_buf, "{s} {s} refs/heads/main\x00 report-status\n", .{ old_hash, new_hash }) catch unreachable;
    const pkt = try pktLine(allocator, cmd_str);
    defer allocator.free(pkt);

    var full_body: std.ArrayList(u8) = .empty;
    defer full_body.deinit(allocator);
    try full_body.appendSlice(allocator, pkt);
    try full_body.appendSlice(allocator, FLUSH);

    const parsed = try parseRefCommands(allocator, full_body.items);
    defer allocator.free(parsed.commands);

    try std.testing.expectEqual(@as(usize, 1), parsed.commands.len);
    try std.testing.expectEqualStrings("refs/heads/main", parsed.commands[0].ref_name);
}

test "full push/clone cycle with in-memory storage" {
    // Use page_allocator to avoid leak-detection noise from protocol internals
    const allocator = std.heap.page_allocator;
    const object_mod = @import("object.zig");
    const pack = @import("pack.zig");

    // ── In-memory storage backend ──
    const MemStore = struct {
        objects: std.StringHashMap([]u8),
        refs: std.StringHashMap([]u8),
        alloc: std.mem.Allocator,

        fn init(a: std.mem.Allocator) @This() {
            return .{
                .objects = std.StringHashMap([]u8).init(a),
                .refs = std.StringHashMap([]u8).init(a),
                .alloc = a,
            };
        }
        fn deinit(self: *@This()) void {
            var oi = self.objects.valueIterator();
            while (oi.next()) |v| self.alloc.free(v.*);
            self.objects.deinit();
            var ri = self.refs.valueIterator();
            while (ri.next()) |v| self.alloc.free(v.*);
            self.refs.deinit();
        }

        fn getObject(_ptr: *anyopaque, a: std.mem.Allocator, hash: []const u8) anyerror!?[]u8 {
            const self: *@This() = @ptrCast(@alignCast(_ptr));
            const v = self.objects.get(hash) orelse return null;
            const copy = try a.alloc(u8, v.len);
            @memcpy(copy, v);
            return copy;
        }
        fn putObject(_ptr: *anyopaque, hash: []const u8, data: []const u8) anyerror!void {
            const self: *@This() = @ptrCast(@alignCast(_ptr));
            if (self.objects.fetchRemove(hash)) |old| {
                self.alloc.free(old.key);
                self.alloc.free(old.value);
            }
            const k = try self.alloc.alloc(u8, hash.len);
            @memcpy(k, hash);
            const v = try self.alloc.alloc(u8, data.len);
            @memcpy(v, data);
            try self.objects.put(k, v);
        }
        fn getRef(_ptr: *anyopaque, a: std.mem.Allocator, name: []const u8) anyerror!?[]u8 {
            const self: *@This() = @ptrCast(@alignCast(_ptr));
            const v = self.refs.get(name) orelse return null;
            const copy = try a.alloc(u8, v.len);
            @memcpy(copy, v);
            return copy;
        }
        fn setRef(_ptr: *anyopaque, name: []const u8, hash: []const u8) anyerror!void {
            const self: *@This() = @ptrCast(@alignCast(_ptr));
            if (self.refs.fetchRemove(name)) |old| {
                self.alloc.free(old.key);
                self.alloc.free(old.value);
            }
            const k = try self.alloc.alloc(u8, name.len);
            @memcpy(k, name);
            const v = try self.alloc.alloc(u8, hash.len);
            @memcpy(v, hash);
            try self.refs.put(k, v);
        }
        fn deleteRef(_ptr: *anyopaque, name: []const u8) anyerror!void {
            const self: *@This() = @ptrCast(@alignCast(_ptr));
            if (self.refs.fetchRemove(name)) |old| {
                self.alloc.free(old.key);
                self.alloc.free(old.value);
            }
        }
        fn listRefs(_ptr: *anyopaque, a: std.mem.Allocator) anyerror![]Ref {
            const self: *@This() = @ptrCast(@alignCast(_ptr));
            var result: std.ArrayList(Ref) = .empty;
            var iter = self.refs.iterator();
            while (iter.next()) |entry| {
                try result.append(a, .{ .name = entry.key_ptr.*, .hash = entry.value_ptr.* });
            }
            return result.toOwnedSlice(a);
        }

        fn adapter(self: *@This()) StorageAdapter {
            return .{
                .ptr = @ptrCast(self),
                .vtable = &.{
                    .getObject = getObject,
                    .putObject = putObject,
                    .getRef = getRef,
                    .setRef = setRef,
                    .deleteRef = deleteRef,
                    .listRefs = listRefs,
                },
            };
        }
    };

    var store = MemStore.init(allocator);
    defer store.deinit();
    const storage = store.adapter();

    // ── Step 1: Advertise refs (empty repo) ──
    const adv1 = try advertiseRefs(allocator, storage, "git-receive-pack");
    defer allocator.free(adv1);
    try std.testing.expect(adv1.len > 0);

    // ── Step 2: Simulate a push with 2 blob objects ──
    const blob1 = "Hello from libgitty test!\n";
    const blob2 = "Second test file.\n";
    const hash1 = object_mod.hashObject(.blob, blob1);
    const hash2 = object_mod.hashObject(.blob, blob2);

    // Build a pack with these objects
    const objects = [_]pack.PackObject{
        .{ .obj_type = .blob, .hash = hash1, .data = blob1 },
        .{ .obj_type = .blob, .hash = hash2, .data = blob2 },
    };
    const pack_data = try pack.buildPack(allocator, &objects);
    defer allocator.free(pack_data);

    // Build receive-pack request: command line + pack data
    const commit_hash_str = "a" ** 40; // fake commit hash
    var body: std.ArrayList(u8) = .empty;
    defer body.deinit(allocator);

    var cmd_buf: [256]u8 = undefined;
    const cmd = std.fmt.bufPrint(&cmd_buf, "{s} {s} refs/heads/main\x00 report-status\n", .{ ZERO_HASH, commit_hash_str }) catch unreachable;
    const cmd_pkt = try pktLine(allocator, cmd);
    defer allocator.free(cmd_pkt);
    try body.appendSlice(allocator, cmd_pkt);
    try body.appendSlice(allocator, FLUSH);
    try body.appendSlice(allocator, pack_data);

    // Handle the push
    const response = try handleReceivePack(allocator, storage, body.items);
    defer allocator.free(response);

    // Verify response contains "unpack ok"
    try std.testing.expect(std.mem.indexOf(u8, response, "unpack ok") != null);

    // ── Step 3: Verify objects were stored ──
    {
        const raw1 = (try storage.getObject(allocator, &hash1)) orelse return error.TestUnexpectedResult;
        defer allocator.free(raw1);
        const dec1 = try object_mod.decodeObject(allocator, raw1);
        defer allocator.free(dec1.data);
        try std.testing.expectEqual(object_mod.ObjectType.blob, dec1.obj_type);
        try std.testing.expectEqualStrings(blob1, dec1.data);
    }

    {
        const raw2 = (try storage.getObject(allocator, &hash2)) orelse return error.TestUnexpectedResult;
        defer allocator.free(raw2);
        const dec2 = try object_mod.decodeObject(allocator, raw2);
        defer allocator.free(dec2.data);
        try std.testing.expectEqual(object_mod.ObjectType.blob, dec2.obj_type);
        try std.testing.expectEqualStrings(blob2, dec2.data);
    }

    // Verify ref was set
    {
        const ref_hash = (try storage.getRef(allocator, "refs/heads/main")) orelse return error.TestUnexpectedResult;
        defer allocator.free(ref_hash);
        try std.testing.expectEqualStrings(commit_hash_str, ref_hash);
    }
}

const std = @import("std");
const diff = @import("diff.zig");
const object = @import("object.zig");
const protocol = @import("protocol.zig");
const sha1 = @import("sha1.zig");
const walk = @import("walk.zig");

pub const ControlPlane = struct {
    allocator: std.mem.Allocator,
    storage: protocol.StorageAdapter,
    repo_id: []const u8,
    file_cache: ?*FileContentCache,

    pub fn init(
        allocator: std.mem.Allocator,
        storage: protocol.StorageAdapter,
        repo_id: []const u8,
        file_cache: ?*FileContentCache,
    ) ControlPlane {
        return .{
            .allocator = allocator,
            .storage = storage,
            .repo_id = repo_id,
            .file_cache = file_cache,
        };
    }

    pub fn getRepoJson(self: *ControlPlane) ![]u8 {
        const default_branch = try self.getDefaultBranch();
        defer self.allocator.free(default_branch);

        return buildRepoJson(self.allocator, self.repo_id, default_branch);
    }

    pub fn listBranchesJson(self: *ControlPlane) ![]u8 {
        const default_branch = try self.getDefaultBranch();
        defer self.allocator.free(default_branch);

        const refs = try self.storage.listRefs(self.allocator);
        defer self.allocator.free(refs);

        var branches: std.ArrayList(BranchJson) = .empty;

        for (refs) |ref| {
            if (!std.mem.startsWith(u8, ref.name, "refs/heads/")) continue;
            const branch_name = ref.name["refs/heads/".len..];
            const commit = try self.commitSummaryFromHash(ref.hash);
            try branches.append(self.allocator, .{
                .name = try self.allocator.dupe(u8, branch_name),
                .commit = commit,
                .protected = std.mem.eql(u8, branch_name, default_branch),
            });
        }

        defer freeBranchList(self.allocator, &branches);
        return buildBranchesJson(self.allocator, branches.items);
    }

    pub fn listCommitsJson(self: *ControlPlane, ref_name: []const u8, limit: usize) ![]u8 {
        const tip = try self.resolveCommitish(ref_name) orelse return error.NotFound;
        defer self.allocator.free(tip);

        const commits = try walk.revList(
            self.allocator,
            .{
                .ptr = self,
                .loadFn = loadObjectForWalk,
            },
            &[_][40]u8{try sliceToHash(tip)},
            &[_][40]u8{},
        );
        defer self.allocator.free(commits);

        var items: std.ArrayList(CommitJson) = .empty;

        const max_count = @min(@max(limit, 1), commits.len);
        for (commits[0..max_count]) |commit_hash| {
            try items.append(self.allocator, try self.commitDetailsFromHash(commit_hash[0..]));
        }

        defer freeCommitList(self.allocator, &items);
        return buildCommitsJson(self.allocator, items.items);
    }

    pub fn getFileContentJson(self: *ControlPlane, path: []const u8, ref_name: []const u8) ![]u8 {
        const tip = try self.resolveCommitish(ref_name) orelse return error.NotFound;
        defer self.allocator.free(tip);

        if (self.file_cache) |cache| {
            const cache_key = try buildFileCacheKey(self.allocator, self.repo_id, tip, path);
            defer self.allocator.free(cache_key);
            if (cache.get(cache_key)) |cached| {
                return buildFileContentJson(self.allocator, path, ref_name, cached);
            }

            const content = try self.getFileContentAtCommit(tip, path);
            if (content) |body| {
                try cache.put(cache_key, body);
                return buildFileContentJson(self.allocator, path, ref_name, body);
            }
            return buildFileContentJson(self.allocator, path, ref_name, null);
        }

        const content = try self.getFileContentAtCommit(tip, path);
        return buildFileContentJson(self.allocator, path, ref_name, content);
    }

    pub fn compareJson(self: *ControlPlane, base_ref: []const u8, head_ref: []const u8, include_patch: bool) ![]u8 {
        const base_tip = try self.resolveCommitish(base_ref) orelse return error.NotFound;
        defer self.allocator.free(base_tip);
        const head_tip = try self.resolveCommitish(head_ref) orelse return error.NotFound;
        defer self.allocator.free(head_tip);

        const base_commit = try self.loadCommit(base_tip) orelse return error.NotFound;
        defer self.allocator.free(base_commit.data);
        const head_commit = try self.loadCommit(head_tip) orelse return error.NotFound;
        defer self.allocator.free(head_commit.data);

        const base_info = try object.parseCommit(self.allocator, base_commit.data);
        defer self.allocator.free(base_info.parents);
        const head_info = try object.parseCommit(self.allocator, head_commit.data);
        defer self.allocator.free(head_info.parents);

        const base_tree = try hexToDigest(base_info.tree_hash);
        const head_tree = try hexToDigest(head_info.tree_hash);

        const changes = try diff.diffTreesRecursive(
            self.allocator,
            .{
                .ptr = self,
                .loadFn = loadTreeForDiff,
            },
            base_tree,
            head_tree,
            "",
        );
        defer diff.freeTreeChanges(self.allocator, changes);

        var files: std.ArrayList(CompareFileJson) = .empty;
        defer freeCompareFileList(self.allocator, &files);

        var additions: usize = 0;
        var deletions: usize = 0;
        var patch: std.ArrayList(u8) = .empty;
        defer patch.deinit(self.allocator);

        for (changes) |change| {
            const old_blob = if (change.old_hash) |h| try self.loadBlobByDigest(h) else null;
            defer if (old_blob) |b| self.allocator.free(b);
            const new_blob = if (change.new_hash) |h| try self.loadBlobByDigest(h) else null;
            defer if (new_blob) |b| self.allocator.free(b);

            const old_text = if (old_blob) |b| b else "";
            const new_text = if (new_blob) |b| b else "";
            const stats = try lineStats(self.allocator, old_text, new_text);
            additions += stats.additions;
            deletions += stats.deletions;

            try files.append(self.allocator, .{
                .filename = try self.allocator.dupe(u8, change.path),
                .additions = stats.additions,
                .deletions = stats.deletions,
                .status = switch (change.kind) {
                    .added => .added,
                    .deleted => .deleted,
                    .modified => .modified,
                },
            });

            if (include_patch) {
                const old_path = if (change.kind == .added) "/dev/null" else change.path;
                const new_path = if (change.kind == .deleted) "/dev/null" else change.path;
                const hunk = try diff.unifiedDiff(self.allocator, old_text, new_text, old_path, new_path);
                defer self.allocator.free(hunk);
                try patch.appendSlice(self.allocator, hunk);
            }
        }

        return buildCompareJson(
            self.allocator,
            base_ref,
            head_ref,
            files.items,
            additions,
            deletions,
            if (include_patch) patch.items else null,
        );
    }

    fn getDefaultBranch(self: *ControlPlane) ![]u8 {
        if (try self.storage.getRef(self.allocator, "HEAD")) |head_ref| {
            defer self.allocator.free(head_ref);
            if (protocol.parseSymbolicRef(head_ref)) |target| {
                if (std.mem.startsWith(u8, target, "refs/heads/")) {
                    return self.allocator.dupe(u8, target["refs/heads/".len..]);
                }
                return self.allocator.dupe(u8, target);
            }
        }

        const refs = try self.storage.listRefs(self.allocator);
        defer self.allocator.free(refs);

        var fallback: ?[]const u8 = null;
        for (refs) |ref| {
            if (!std.mem.startsWith(u8, ref.name, "refs/heads/")) continue;
            const branch_name = ref.name["refs/heads/".len..];
            if (std.mem.eql(u8, branch_name, "main")) return self.allocator.dupe(u8, branch_name);
            if (fallback == null) fallback = branch_name;
        }

        return self.allocator.dupe(u8, fallback orelse "main");
    }

    fn branchCommitSummaryFromHash(self: *ControlPlane, hash: []const u8) !CommitSummaryJson {
        return try self.commitSummaryFromHash(hash);
    }

    fn commitDetailsFromHash(self: *ControlPlane, hash: []const u8) !CommitJson {
        const obj = try self.loadCommit(hash) orelse return error.NotFound;
        defer self.allocator.free(obj.data);

        const info = try object.parseCommit(self.allocator, obj.data);
        defer self.allocator.free(info.parents);

        const author = parsePersonLine(info.author) catch null;
        const committer = parsePersonLine(info.committer) catch null;

        const sha = try self.allocator.dupe(u8, hash);
        errdefer self.allocator.free(sha);
        const message = try self.allocator.dupe(u8, firstLine(info.message));
        errdefer self.allocator.free(message);
        const author_name = if (author) |p| try self.allocator.dupe(u8, p.name) else null;
        errdefer if (author_name) |v| self.allocator.free(v);
        const author_email = if (author) |p| try self.allocator.dupe(u8, p.email) else null;
        errdefer if (author_email) |v| self.allocator.free(v);
        const timestamp = if (committer) |p| try formatIsoUtc(self.allocator, p.timestamp) else null;
        errdefer if (timestamp) |v| self.allocator.free(v);

        return .{
            .sha = sha,
            .message = message,
            .author_name = author_name,
            .author_email = author_email,
            .timestamp = timestamp,
        };
    }

    fn commitSummaryFromHash(self: *ControlPlane, hash: []const u8) !CommitSummaryJson {
        const obj = try self.loadCommit(hash) orelse return error.NotFound;
        defer self.allocator.free(obj.data);

        const info = try object.parseCommit(self.allocator, obj.data);
        defer self.allocator.free(info.parents);
        const committer = parsePersonLine(info.committer) catch null;

        const id = try self.allocator.dupe(u8, hash);
        errdefer self.allocator.free(id);
        const message = try self.allocator.dupe(u8, firstLine(info.message));
        errdefer self.allocator.free(message);
        const timestamp = if (committer) |p| try formatIsoUtc(self.allocator, p.timestamp) else try formatIsoUtc(self.allocator, 0);
        errdefer self.allocator.free(timestamp);

        return .{
            .id = id,
            .message = message,
            .timestamp = timestamp,
        };
    }

    fn getFileContent(self: *ControlPlane, path: []const u8, ref_name: []const u8) !?[]u8 {
        const tip = try self.resolveCommitish(ref_name) orelse return null;
        defer self.allocator.free(tip);
        return self.getFileContentAtCommit(tip, path);
    }

    fn getFileContentAtCommit(self: *ControlPlane, tip: []const u8, path: []const u8) !?[]u8 {
        const commit = try self.loadCommit(tip) orelse return null;
        defer self.allocator.free(commit.data);

        const info = try object.parseCommit(self.allocator, commit.data);
        defer self.allocator.free(info.parents);
        std.debug.print("[control-plane] parsed tree hash={s}\n", .{info.tree_hash});

        return try self.readPathFromTree(info.tree_hash, path);
    }

    fn readPathFromTree(self: *ControlPlane, tree_hash_hex: [40]u8, path: []const u8) !?[]u8 {
        const total_segments = countPathSegments(path);
        if (total_segments == 0) return null;

        var current_tree = tree_hash_hex;
        var segments = std.mem.tokenizeScalar(u8, path, '/');
        var segment_index: usize = 0;
        while (segments.next()) |part| {
            const tree_obj = try self.loadObject(current_tree[0..]) orelse return null;
            defer self.allocator.free(tree_obj.data);
            if (tree_obj.obj_type != .tree) return null;

            const entry = try findTreeEntry(tree_obj.data, part) orelse return null;
            const entry_hex = sha1.digestToHex(&entry.hash);

            if (segment_index + 1 < total_segments) {
                @memcpy(&current_tree, entry_hex[0..]);
                segment_index += 1;
                continue;
            }

            const leaf_obj = try self.loadObject(entry_hex[0..]) orelse return null;
            defer self.allocator.free(leaf_obj.data);
            if (leaf_obj.obj_type != .blob) return null;
            return try self.allocator.dupe(u8, leaf_obj.data);
        }

        return null;
    }

    fn loadObject(self: *ControlPlane, hash: []const u8) !?LoadedObject {
        std.debug.print("[control-plane] loadObject hash={s}\n", .{hash});
        const raw = try self.storage.getObject(self.allocator, hash) orelse return null;
        defer self.allocator.free(raw);
        const decoded = try object.decodeObject(self.allocator, raw);
        return .{
            .obj_type = decoded.obj_type,
            .data = decoded.data,
        };
    }

    fn loadCommit(self: *ControlPlane, hash: []const u8) !?LoadedObject {
        const obj = try self.loadObject(hash) orelse return null;
        if (obj.obj_type != .commit) {
            self.allocator.free(obj.data);
            return null;
        }
        return obj;
    }

    fn loadBlobByDigest(self: *ControlPlane, digest: sha1.Digest) !?[]u8 {
        const hex = sha1.digestToHex(&digest);
        const obj = try self.loadObject(hex[0..]) orelse return null;
        if (obj.obj_type != .blob) {
            self.allocator.free(obj.data);
            return null;
        }
        return obj.data;
    }

    fn resolveCommitish(self: *ControlPlane, name: []const u8) !?[]u8 {
        if (isHexSha1(name)) {
            return @as(?[]u8, try self.allocator.dupe(u8, name));
        }
        return try protocol.resolveRef(self.allocator, self.storage, name);
    }
};

const LoadedObject = struct {
    obj_type: object.ObjectType,
    data: []u8,
};

const CommitJson = struct {
    sha: []u8,
    message: []u8,
    author_name: ?[]u8,
    author_email: ?[]u8,
    timestamp: ?[]u8,
};

const CommitSummaryJson = struct {
    id: []u8,
    message: []u8,
    timestamp: []u8,
};

const BranchJson = struct {
    name: []u8,
    commit: CommitSummaryJson,
    protected: bool,
};

const CompareFileStatus = enum {
    added,
    modified,
    deleted,
    renamed,
};

const CompareFileJson = struct {
    filename: []u8,
    additions: usize,
    deletions: usize,
    status: CompareFileStatus,
};

pub const FileContentCache = struct {
    const MAX_ENTRIES = 64;

    allocator: std.mem.Allocator,
    entries: std.StringHashMap([]u8),

    pub fn init(allocator: std.mem.Allocator) FileContentCache {
        return .{
            .allocator = allocator,
            .entries = std.StringHashMap([]u8).init(allocator),
        };
    }

    pub fn deinit(self: *FileContentCache) void {
        self.clear();
        self.entries.deinit();
    }

    pub fn get(self: *FileContentCache, key: []const u8) ?[]const u8 {
        return self.entries.get(key);
    }

    pub fn put(self: *FileContentCache, key: []const u8, value: []const u8) !void {
        if (self.entries.count() >= MAX_ENTRIES) {
            self.clear();
        }
        if (self.entries.get(key) != null) return;

        const key_copy = try self.allocator.dupe(u8, key);
        errdefer self.allocator.free(key_copy);
        const value_copy = try self.allocator.dupe(u8, value);
        errdefer self.allocator.free(value_copy);
        try self.entries.put(key_copy, value_copy);
    }

    fn clear(self: *FileContentCache) void {
        var it = self.entries.iterator();
        while (it.next()) |entry| {
            self.allocator.free(entry.key_ptr.*);
            self.allocator.free(entry.value_ptr.*);
        }
        self.entries.clearRetainingCapacity();
    }
};

const JsonBuilder = struct {
    allocator: std.mem.Allocator,
    items: std.ArrayList(u8),

    fn init(allocator: std.mem.Allocator) JsonBuilder {
        return .{
            .allocator = allocator,
            .items = .empty,
        };
    }

    fn deinit(self: *JsonBuilder) void {
        self.items.deinit(self.allocator);
    }

    fn finish(self: *JsonBuilder) ![]u8 {
        return self.items.toOwnedSlice(self.allocator);
    }

    fn append(self: *JsonBuilder, bytes: []const u8) !void {
        try self.items.appendSlice(self.allocator, bytes);
    }

    fn appendByte(self: *JsonBuilder, byte: u8) !void {
        try self.items.append(self.allocator, byte);
    }

    fn appendComma(self: *JsonBuilder) !void {
        try self.appendByte(',');
    }

    fn appendKey(self: *JsonBuilder, key: []const u8) !void {
        try self.appendQuoted(key);
        try self.appendByte(':');
    }

    fn appendQuoted(self: *JsonBuilder, value: []const u8) !void {
        try self.appendByte('"');
        for (value) |c| {
            switch (c) {
                '"' => try self.append("\\\""),
                '\\' => try self.append("\\\\"),
                '\n' => try self.append("\\n"),
                '\r' => try self.append("\\r"),
                '\t' => try self.append("\\t"),
                8 => try self.append("\\b"),
                12 => try self.append("\\f"),
                else => {
                    if (c < 0x20) {
                        var buf: [6]u8 = undefined;
                        const hex = "0123456789abcdef";
                        buf[0] = '\\';
                        buf[1] = 'u';
                        buf[2] = '0';
                        buf[3] = '0';
                        buf[4] = hex[c >> 4];
                        buf[5] = hex[c & 0x0f];
                        try self.append(buf[0..]);
                    } else {
                        try self.appendByte(c);
                    }
                },
            }
        }
        try self.appendByte('"');
    }

    fn appendBool(self: *JsonBuilder, value: bool) !void {
        try self.append(if (value) "true" else "false");
    }

    fn appendUsize(self: *JsonBuilder, value: usize) !void {
        var buf: [32]u8 = undefined;
        const slice = try std.fmt.bufPrint(&buf, "{d}", .{value});
        try self.append(slice);
    }
};

fn buildRepoJson(allocator: std.mem.Allocator, repo_id: []const u8, default_branch: []const u8) ![]u8 {
    const repo = splitRepoId(repo_id);
    var json = JsonBuilder.init(allocator);
    errdefer json.deinit();

    try json.append("{");
    try json.appendKey("id");
    try json.appendQuoted(repo_id);
    try json.appendComma();
    try json.appendKey("owner");
    try json.appendQuoted(repo.owner);
    try json.appendComma();
    try json.appendKey("name");
    try json.appendQuoted(repo.name);
    try json.appendComma();
    try json.appendKey("full_name");
    try json.appendQuoted(repo_id);
    try json.appendComma();
    try json.appendKey("default_branch");
    try json.appendQuoted(default_branch);
    try json.appendComma();
    try json.appendKey("visibility");
    try json.appendQuoted("private");
    try json.append("}");
    return json.finish();
}

fn buildBranchesJson(allocator: std.mem.Allocator, branches: []const BranchJson) ![]u8 {
    var json = JsonBuilder.init(allocator);
    errdefer json.deinit();
    try json.append("[");
    for (branches, 0..) |branch, index| {
        if (index != 0) try json.appendComma();
        try json.append("{");
        try json.appendKey("name");
        try json.appendQuoted(branch.name);
        try json.appendComma();
        try json.appendKey("commit");
        try appendCommitSummaryJson(&json, branch.commit);
        try json.appendComma();
        try json.appendKey("protected");
        try json.appendBool(branch.protected);
        try json.append("}");
    }
    try json.append("]");
    return json.finish();
}

fn buildCommitsJson(allocator: std.mem.Allocator, commits: []const CommitJson) ![]u8 {
    var json = JsonBuilder.init(allocator);
    errdefer json.deinit();
    try json.append("[");
    for (commits, 0..) |commit, index| {
        if (index != 0) try json.appendComma();
        try appendCommitJson(&json, commit);
    }
    try json.append("]");
    return json.finish();
}

fn buildFileContentJson(allocator: std.mem.Allocator, path: []const u8, ref_name: []const u8, content: ?[]const u8) ![]u8 {
    var json = JsonBuilder.init(allocator);
    errdefer json.deinit();
    try json.append("{");
    try json.appendKey("path");
    try json.appendQuoted(path);
    try json.appendComma();
    try json.appendKey("ref");
    try json.appendQuoted(ref_name);
    try json.appendComma();
    try json.appendKey("content");
    if (content) |value| {
        try json.appendQuoted(value);
    } else {
        try json.append("null");
    }
    try json.append("}");
    return json.finish();
}

fn buildCompareJson(
    allocator: std.mem.Allocator,
    base_ref: []const u8,
    head_ref: []const u8,
    files: []const CompareFileJson,
    additions: usize,
    deletions: usize,
    patch: ?[]const u8,
) ![]u8 {
    var json = JsonBuilder.init(allocator);
    errdefer json.deinit();
    try json.append("{");
    try json.appendKey("base");
    try json.appendQuoted(base_ref);
    try json.appendComma();
    try json.appendKey("head");
    try json.appendQuoted(head_ref);
    try json.appendComma();
    try json.appendKey("files_changed");
    try json.appendUsize(files.len);
    try json.appendComma();
    try json.appendKey("additions");
    try json.appendUsize(additions);
    try json.appendComma();
    try json.appendKey("deletions");
    try json.appendUsize(deletions);
    try json.appendComma();
    try json.appendKey("files");
    try appendCompareFilesJson(&json, files);
    if (patch) |patch_text| {
        try json.appendComma();
        try json.appendKey("patch");
        try json.appendQuoted(patch_text);
    }
    try json.append("}");
    return json.finish();
}

fn appendCommitSummaryJson(json: *JsonBuilder, commit: CommitSummaryJson) !void {
    try json.append("{");
    try json.appendKey("id");
    try json.appendQuoted(commit.id);
    try json.appendComma();
    try json.appendKey("message");
    try json.appendQuoted(commit.message);
    try json.appendComma();
    try json.appendKey("timestamp");
    try json.appendQuoted(commit.timestamp);
    try json.append("}");
}

fn appendCommitJson(json: *JsonBuilder, commit: CommitJson) !void {
    try json.append("{");
    try json.appendKey("sha");
    try json.appendQuoted(commit.sha);
    try json.appendComma();
    try json.appendKey("message");
    try json.appendQuoted(commit.message);
    try json.appendComma();
    try json.appendKey("author_name");
    if (commit.author_name) |author_name| {
        try json.appendQuoted(author_name);
    } else {
        try json.append("null");
    }
    try json.appendComma();
    try json.appendKey("author_email");
    if (commit.author_email) |author_email| {
        try json.appendQuoted(author_email);
    } else {
        try json.append("null");
    }
    try json.appendComma();
    try json.appendKey("timestamp");
    if (commit.timestamp) |timestamp| {
        try json.appendQuoted(timestamp);
    } else {
        try json.append("null");
    }
    try json.append("}");
}

fn appendCompareFilesJson(json: *JsonBuilder, files: []const CompareFileJson) !void {
    try json.append("[");
    for (files, 0..) |file, index| {
        if (index != 0) try json.appendComma();
        try json.append("{");
        try json.appendKey("filename");
        try json.appendQuoted(file.filename);
        try json.appendComma();
        try json.appendKey("additions");
        try json.appendUsize(file.additions);
        try json.appendComma();
        try json.appendKey("deletions");
        try json.appendUsize(file.deletions);
        try json.appendComma();
        try json.appendKey("status");
        try json.appendQuoted(@tagName(file.status));
        try json.append("}");
    }
    try json.append("]");
}

fn findTreeEntry(tree_data: []const u8, wanted: []const u8) !?object.TreeEntry {
    var pos: usize = 0;
    while (pos < tree_data.len) {
        const space_idx = std.mem.indexOfScalarPos(u8, tree_data, pos, ' ') orelse return error.InvalidData;
        const mode = tree_data[pos..space_idx];
        const null_idx = std.mem.indexOfScalarPos(u8, tree_data, space_idx + 1, 0) orelse return error.InvalidData;
        const name = tree_data[space_idx + 1 .. null_idx];
        if (std.mem.eql(u8, name, wanted)) {
            if (null_idx + 1 + 20 > tree_data.len) return error.InvalidData;
            var hash: sha1.Digest = undefined;
            @memcpy(&hash, tree_data[null_idx + 1 ..][0..20]);
            return .{ .mode = mode, .name = name, .hash = hash };
        }
        pos = null_idx + 21;
    }
    return null;
}

fn buildFileCacheKey(allocator: std.mem.Allocator, repo_id: []const u8, commit_id: []const u8, path: []const u8) ![]u8 {
    return std.fmt.allocPrint(allocator, "{s}:{s}:{s}", .{ repo_id, commit_id, path });
}

fn splitRepoId(repo_id: []const u8) struct { owner: []const u8, name: []const u8 } {
    const slash = std.mem.indexOfScalar(u8, repo_id, '/') orelse return .{ .owner = repo_id, .name = "" };
    return .{ .owner = repo_id[0..slash], .name = repo_id[slash + 1 ..] };
}

fn parsePersonLine(line: []const u8) !struct { name: []const u8, email: []const u8, timestamp: i64 } {
    const end_email = std.mem.lastIndexOfScalar(u8, line, '>') orelse return error.InvalidData;
    const start_email = std.mem.lastIndexOfScalar(u8, line[0..end_email], '<') orelse return error.InvalidData;
    const name = std.mem.trim(u8, line[0..start_email], " ");
    const email = line[start_email + 1 .. end_email];
    const tail = std.mem.trim(u8, line[end_email + 1 ..], " ");
    var iter = std.mem.splitScalar(u8, tail, ' ');
    const timestamp_str = iter.next() orelse return error.InvalidData;
    const timestamp = std.fmt.parseInt(i64, timestamp_str, 10) catch return error.InvalidData;
    return .{ .name = name, .email = email, .timestamp = timestamp };
}

fn formatIsoUtc(allocator: std.mem.Allocator, unix_seconds: i64) ![]u8 {
    const secs: u64 = if (unix_seconds < 0) 0 else @as(u64, @intCast(unix_seconds));
    const epoch_seconds = std.time.epoch.EpochSeconds{ .secs = secs };
    const year_day = epoch_seconds.getEpochDay().calculateYearDay();
    const month_day = year_day.calculateMonthDay();
    const day_seconds = epoch_seconds.getDaySeconds();
    return std.fmt.allocPrint(
        allocator,
        "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}Z",
        .{
            year_day.year,
            month_day.month.numeric(),
            month_day.day_index + 1,
            day_seconds.getHoursIntoDay(),
            day_seconds.getMinutesIntoHour(),
            day_seconds.getSecondsIntoMinute(),
        },
    );
}

fn firstLine(message: []const u8) []const u8 {
    const newline = std.mem.indexOfScalar(u8, message, '\n') orelse message.len;
    return message[0..newline];
}

fn splitPathSegments(allocator: std.mem.Allocator, path: []const u8) ![]const []const u8 {
    var segments: std.ArrayList([]const u8) = .empty;
    errdefer segments.deinit(allocator);

    var iter = std.mem.tokenizeScalar(u8, path, '/');
    while (iter.next()) |segment| {
        try segments.append(allocator, segment);
    }

    return segments.toOwnedSlice(allocator);
}

fn countPathSegments(path: []const u8) usize {
    var count: usize = 0;
    var iter = std.mem.tokenizeScalar(u8, path, '/');
    while (iter.next()) |_| {
        count += 1;
    }
    return count;
}

fn lineStats(allocator: std.mem.Allocator, old_text: []const u8, new_text: []const u8) !struct { additions: usize, deletions: usize } {
    const lines = try diff.diffLines(allocator, old_text, new_text);
    defer allocator.free(lines);
    var additions: usize = 0;
    var deletions: usize = 0;
    for (lines) |line| {
        switch (line.op) {
            .insert => additions += 1,
            .delete => deletions += 1,
            .equal => {},
        }
    }
    return .{ .additions = additions, .deletions = deletions };
}

fn freeCommitList(allocator: std.mem.Allocator, list: *std.ArrayList(CommitJson)) void {
    for (list.items) |item| {
        allocator.free(item.sha);
        allocator.free(item.message);
        if (item.author_name) |v| allocator.free(v);
        if (item.author_email) |v| allocator.free(v);
        if (item.timestamp) |v| allocator.free(v);
    }
    list.deinit(allocator);
}

fn freeBranchList(allocator: std.mem.Allocator, list: *std.ArrayList(BranchJson)) void {
    for (list.items) |item| {
        allocator.free(item.name);
        allocator.free(item.commit.id);
        allocator.free(item.commit.message);
        allocator.free(item.commit.timestamp);
    }
    list.deinit(allocator);
}

fn freeCompareFileList(allocator: std.mem.Allocator, list: *std.ArrayList(CompareFileJson)) void {
    for (list.items) |item| allocator.free(item.filename);
    list.deinit(allocator);
}

fn sliceToHash(hash: []const u8) ![40]u8 {
    if (hash.len != 40) return error.InvalidData;
    var out: [40]u8 = undefined;
    @memcpy(&out, hash);
    return out;
}

fn hexToDigest(hash: [40]u8) !sha1.Digest {
    var digest: sha1.Digest = undefined;
    var i: usize = 0;
    while (i < 20) : (i += 1) {
        const hi = hexValue(hash[i * 2]) orelse return error.InvalidData;
        const lo = hexValue(hash[i * 2 + 1]) orelse return error.InvalidData;
        digest[i] = @as(u8, @intCast((hi << 4) | lo));
    }
    return digest;
}

fn hexValue(c: u8) ?u8 {
    return switch (c) {
        '0'...'9' => c - '0',
        'a'...'f' => c - 'a' + 10,
        'A'...'F' => c - 'A' + 10,
        else => null,
    };
}

fn isHexSha1(input: []const u8) bool {
    if (input.len != 40) return false;
    for (input) |c| {
        if (hexValue(c) == null) return false;
    }
    return true;
}

fn loadObjectForWalk(ptr: *anyopaque, allocator: std.mem.Allocator, hash: [40]u8) anyerror!?walk.LoadedObject {
    _ = allocator;
    const self: *ControlPlane = @ptrCast(@alignCast(ptr));
    const obj = try self.loadObject(hash[0..]) orelse return null;
    return .{
        .obj_type = obj.obj_type,
        .data = obj.data,
    };
}

fn loadTreeForDiff(ptr: *anyopaque, allocator: std.mem.Allocator, hash: sha1.Digest) anyerror!?[]u8 {
    _ = allocator;
    const self: *ControlPlane = @ptrCast(@alignCast(ptr));
    const hex = sha1.digestToHex(&hash);
    const obj = try self.loadObject(hex[0..]) orelse return null;
    if (obj.obj_type != .tree) {
        self.allocator.free(obj.data);
        return null;
    }
    return obj.data;
}

test "iso timestamp formatting" {
    const allocator = std.testing.allocator;
    const iso = try formatIsoUtc(allocator, 0);
    defer allocator.free(iso);
    try std.testing.expectEqualStrings("1970-01-01T00:00:00Z", iso);
}

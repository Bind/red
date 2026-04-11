/// Line-level diff engine.
/// Produces unified diffs for the bottega web UI, similar to ripgit's diff.rs.
///
/// Uses the Myers diff algorithm (shortest edit script) — same algorithm
/// as GNU diff and git's internal diff.
const std = @import("std");

pub const DiffOp = enum {
    equal,
    insert,
    delete,
};

pub const DiffLine = struct {
    op: DiffOp,
    text: []const u8,
};

/// Compute a line-level diff between two texts.
/// Returns a list of DiffLine entries.
/// Caller owns the returned slice (free with allocator.free).
pub fn diffLines(allocator: std.mem.Allocator, a: []const u8, b: []const u8) ![]DiffLine {
    // Split into lines
    const a_lines = try splitLines(allocator, a);
    defer allocator.free(a_lines);
    const b_lines = try splitLines(allocator, b);
    defer allocator.free(b_lines);

    // Myers diff: find shortest edit script
    const edits = try myersDiff(allocator, a_lines, b_lines);
    return edits;
}

/// Generate a unified diff string (like `git diff` output).
pub fn unifiedDiff(
    allocator: std.mem.Allocator,
    a: []const u8,
    b: []const u8,
    diff_path_a: []const u8,
    diff_path_b: []const u8,
    header_path_a: []const u8,
    header_path_b: []const u8,
) ![]u8 {
    const diff = try diffLines(allocator, a, b);
    defer allocator.free(diff);

    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(allocator);

    const git_path_a = try gitDiffPath(allocator, diff_path_a, .old);
    defer allocator.free(git_path_a);
    const git_path_b = try gitDiffPath(allocator, diff_path_b, .new);
    defer allocator.free(git_path_b);

    // Git-style file header so downstream consumers can split patches by file.
    try appendFmt(allocator, &out, "diff --git {s} {s}\n", .{ git_path_a, git_path_b });
    try appendFmt(allocator, &out, "--- {s}\n", .{header_path_a});
    try appendFmt(allocator, &out, "+++ {s}\n", .{header_path_b});

    // Generate hunks
    var i: usize = 0;
    while (i < diff.len) {
        // Skip equal lines to find the next change
        if (diff[i].op == .equal) {
            i += 1;
            continue;
        }

        // Context: 3 lines before
        const ctx_start = if (i >= 3) i - 3 else 0;

        // Find end of this hunk (change + 3 lines context)
        var end = i;
        var last_change = i;
        while (end < diff.len) : (end += 1) {
            if (diff[end].op != .equal) {
                last_change = end;
            } else if (end - last_change > 3) {
                break;
            }
        }
        const ctx_end = @min(end, diff.len);

        // Count lines for hunk header
        var old_start: usize = 1;
        var old_count: usize = 0;
        var new_start: usize = 1;
        var new_count: usize = 0;

        // Count lines before hunk
        for (diff[0..ctx_start]) |d| {
            switch (d.op) {
                .equal => {
                    old_start += 1;
                    new_start += 1;
                },
                .delete => old_start += 1,
                .insert => new_start += 1,
            }
        }

        for (diff[ctx_start..ctx_end]) |d| {
            switch (d.op) {
                .equal => {
                    old_count += 1;
                    new_count += 1;
                },
                .delete => old_count += 1,
                .insert => new_count += 1,
            }
        }

        try appendFmt(allocator, &out, "@@ -{d},{d} +{d},{d} @@\n", .{
            old_start, old_count, new_start, new_count,
        });

        for (diff[ctx_start..ctx_end]) |d| {
            const prefix: u8 = switch (d.op) {
                .equal => ' ',
                .insert => '+',
                .delete => '-',
            };
            try out.append(allocator, prefix);
            try out.appendSlice(allocator, d.text);
            try out.append(allocator, '\n');
        }

        i = ctx_end;
    }

    return out.toOwnedSlice(allocator);
}

const GitPathKind = enum {
    old,
    new,
};

fn gitDiffPath(allocator: std.mem.Allocator, path: []const u8, kind: GitPathKind) ![]u8 {
    if (std.mem.eql(u8, path, "/dev/null")) {
        return allocator.dupe(u8, path);
    }

    const prefix = switch (kind) {
        .old => "a/",
        .new => "b/",
    };
    return std.fmt.allocPrint(allocator, "{s}{s}", .{ prefix, path });
}

fn appendFmt(allocator: std.mem.Allocator, out: *std.ArrayList(u8), comptime fmt: []const u8, args: anytype) !void {
    var buf: [256]u8 = undefined;
    const s = std.fmt.bufPrint(&buf, fmt, args) catch {
        // Fallback for long strings
        try out.appendSlice(allocator, "...\n");
        return;
    };
    try out.appendSlice(allocator, s);
}

fn splitLines(allocator: std.mem.Allocator, text: []const u8) ![]const []const u8 {
    if (text.len == 0) return try allocator.alloc([]const u8, 0);

    var lines: std.ArrayList([]const u8) = .empty;
    errdefer lines.deinit(allocator);

    var iter = std.mem.splitScalar(u8, text, '\n');
    while (iter.next()) |line| {
        try lines.append(allocator, line);
    }

    // Remove trailing empty line from final newline
    if (lines.items.len > 0 and lines.items[lines.items.len - 1].len == 0) {
        _ = lines.pop();
    }

    return lines.toOwnedSlice(allocator);
}

/// Myers diff algorithm — O(ND) time, O(N) space.
fn myersDiff(
    allocator: std.mem.Allocator,
    a: []const []const u8,
    b: []const []const u8,
) ![]DiffLine {
    const n = a.len;
    const m = b.len;
    const max_d = n + m;

    if (max_d == 0) return try allocator.alloc(DiffLine, 0);

    // For simplicity, use the O(MN) LCS approach for small inputs
    // and fall back to a simple greedy approach for large ones.
    if (n + m > 10000) {
        return try simpleDiff(allocator, a, b);
    }

    // Build edit graph using Myers algorithm
    // V array: maps k-diagonal to furthest-reaching x
    const v_size = 2 * max_d + 1;
    const v_off = max_d; // offset so k can be negative

    // Store all V arrays for backtracking
    var trace: std.ArrayList([]isize) = .empty;
    defer {
        for (trace.items) |vv| allocator.free(vv);
        trace.deinit(allocator);
    }

    var v = try allocator.alloc(isize, v_size);
    @memset(v, 0);
    v[v_off + 1] = 0;

    var found = false;
    var d: usize = 0;
    while (d <= max_d) : (d += 1) {
        // Save current V for backtracking
        const v_copy = try allocator.alloc(isize, v_size);
        @memcpy(v_copy, v);
        try trace.append(allocator, v_copy);

        const d_signed: isize = @intCast(d);
        var k: isize = -d_signed;
        while (k <= d_signed) : (k += 2) {
            const ki: usize = @intCast(k + @as(isize, @intCast(v_off)));
            var x: isize = undefined;

            if (k == -d_signed or (k != d_signed and v[ki - 1] < v[ki + 1])) {
                x = v[ki + 1]; // move down
            } else {
                x = v[ki - 1] + 1; // move right
            }
            var y = x - k;

            // Follow diagonal (equal lines)
            while (x < @as(isize, @intCast(n)) and y < @as(isize, @intCast(m)) and
                std.mem.eql(u8, a[@intCast(x)], b[@intCast(y)]))
            {
                x += 1;
                y += 1;
            }

            v[ki] = x;

            if (x >= @as(isize, @intCast(n)) and y >= @as(isize, @intCast(m))) {
                found = true;
                break;
            }
        }
        if (found) break;
    }
    allocator.free(v);

    // Backtrack to build the edit script
    var result: std.ArrayList(DiffLine) = .empty;
    errdefer result.deinit(allocator);

    var cx: isize = @intCast(n);
    var cy: isize = @intCast(m);

    var di: isize = @intCast(d);
    while (di >= 0) : (di -= 1) {
        const dv = trace.items[@intCast(di)];
        const ck = cx - cy;
        const cki: usize = @intCast(ck + @as(isize, @intCast(v_off)));

        var prev_x: isize = undefined;
        var prev_k: isize = undefined;

        if (ck == -di or (ck != di and dv[cki - 1] < dv[cki + 1])) {
            prev_k = ck + 1;
            prev_x = dv[@intCast(prev_k + @as(isize, @intCast(v_off)))];
        } else {
            prev_k = ck - 1;
            prev_x = dv[@intCast(prev_k + @as(isize, @intCast(v_off)))];
        }
        const prev_y = prev_x - prev_k;

        // Diagonal moves (equal)
        while (cx > prev_x and cy > prev_y) {
            cx -= 1;
            cy -= 1;
            try result.append(allocator, .{ .op = .equal, .text = a[@intCast(cx)] });
        }

        if (di > 0) {
            if (cx == prev_x) {
                // Down = insert
                cy -= 1;
                try result.append(allocator, .{ .op = .insert, .text = b[@intCast(cy)] });
            } else {
                // Right = delete
                cx -= 1;
                try result.append(allocator, .{ .op = .delete, .text = a[@intCast(cx)] });
            }
        }
    }

    // Reverse since we built it backwards
    std.mem.reverse(DiffLine, result.items);
    return result.toOwnedSlice(allocator);
}

/// Simple diff for large inputs — just shows all deletes then all inserts.
fn simpleDiff(allocator: std.mem.Allocator, a: []const []const u8, b: []const []const u8) ![]DiffLine {
    var result: std.ArrayList(DiffLine) = .empty;
    errdefer result.deinit(allocator);

    for (a) |line| {
        try result.append(allocator, .{ .op = .delete, .text = line });
    }
    for (b) |line| {
        try result.append(allocator, .{ .op = .insert, .text = line });
    }

    return result.toOwnedSlice(allocator);
}

// ──────────── Tree diff (comparing two git trees) ────────────

const sha1_mod = @import("sha1.zig");
const object_mod = @import("object.zig");

/// Type of change in a tree diff.
pub const TreeChangeKind = enum {
    added,
    deleted,
    modified,
};

/// A single change between two trees.
pub const TreeChange = struct {
    kind: TreeChangeKind,
    path: []const u8,
    old_hash: ?sha1_mod.Digest,
    new_hash: ?sha1_mod.Digest,
    old_mode: ?[]const u8,
    new_mode: ?[]const u8,
};

pub fn freeTreeChanges(allocator: std.mem.Allocator, changes: []TreeChange) void {
    for (changes) |change| {
        allocator.free(change.path);
        if (change.old_mode) |mode| allocator.free(mode);
        if (change.new_mode) |mode| allocator.free(mode);
    }
    allocator.free(changes);
}

/// Compare two tree objects (as raw tree data, not parsed).
/// Returns a list of changes. Both trees must be valid git tree object data.
/// Caller owns the result (free each path, then the slice).
pub fn diffTrees(
    allocator: std.mem.Allocator,
    old_tree: ?[]const u8,
    new_tree: ?[]const u8,
) ![]TreeChange {
    const old_entries = if (old_tree) |t|
        try object_mod.parseTree(allocator, t)
    else
        try allocator.alloc(object_mod.TreeEntry, 0);
    defer allocator.free(old_entries);

    const new_entries = if (new_tree) |t|
        try object_mod.parseTree(allocator, t)
    else
        try allocator.alloc(object_mod.TreeEntry, 0);
    defer allocator.free(new_entries);

    var changes: std.ArrayList(TreeChange) = .empty;
    errdefer changes.deinit(allocator);

    // Both lists are sorted by name (git requirement).
    // Merge-join to find additions, deletions, and modifications.
    var oi: usize = 0;
    var ni: usize = 0;

    while (oi < old_entries.len and ni < new_entries.len) {
        const cmp = std.mem.order(u8, old_entries[oi].name, new_entries[ni].name);
        switch (cmp) {
            .lt => {
                // In old but not new → deleted
                try changes.append(allocator, .{
                    .kind = .deleted,
                    .path = try allocator.dupe(u8, old_entries[oi].name),
                    .old_hash = old_entries[oi].hash,
                    .new_hash = null,
                    .old_mode = try allocator.dupe(u8, old_entries[oi].mode),
                    .new_mode = null,
                });
                oi += 1;
            },
            .gt => {
                // In new but not old → added
                try changes.append(allocator, .{
                    .kind = .added,
                    .path = try allocator.dupe(u8, new_entries[ni].name),
                    .old_hash = null,
                    .new_hash = new_entries[ni].hash,
                    .old_mode = null,
                    .new_mode = try allocator.dupe(u8, new_entries[ni].mode),
                });
                ni += 1;
            },
            .eq => {
                // Same name — check if hash changed
                if (!std.mem.eql(u8, &old_entries[oi].hash, &new_entries[ni].hash)) {
                    try changes.append(allocator, .{
                        .kind = .modified,
                        .path = try allocator.dupe(u8, old_entries[oi].name),
                        .old_hash = old_entries[oi].hash,
                        .new_hash = new_entries[ni].hash,
                        .old_mode = try allocator.dupe(u8, old_entries[oi].mode),
                        .new_mode = try allocator.dupe(u8, new_entries[ni].mode),
                    });
                }
                oi += 1;
                ni += 1;
            },
        }
    }

    // Remaining old entries are deletions
    while (oi < old_entries.len) : (oi += 1) {
        try changes.append(allocator, .{
            .kind = .deleted,
            .path = try allocator.dupe(u8, old_entries[oi].name),
            .old_hash = old_entries[oi].hash,
            .new_hash = null,
            .old_mode = try allocator.dupe(u8, old_entries[oi].mode),
            .new_mode = null,
        });
    }

    // Remaining new entries are additions
    while (ni < new_entries.len) : (ni += 1) {
        try changes.append(allocator, .{
            .kind = .added,
            .path = try allocator.dupe(u8, new_entries[ni].name),
            .old_hash = null,
            .new_hash = new_entries[ni].hash,
            .old_mode = null,
            .new_mode = try allocator.dupe(u8, new_entries[ni].mode),
        });
    }

    return changes.toOwnedSlice(allocator);
}

/// Callback for loading tree data by hash (for recursive tree diff).
pub const TreeLoader = struct {
    ptr: *anyopaque,
    loadFn: *const fn (ptr: *anyopaque, allocator: std.mem.Allocator, hash: sha1_mod.Digest) anyerror!?[]u8,

    pub fn load(self: TreeLoader, allocator: std.mem.Allocator, hash: sha1_mod.Digest) !?[]u8 {
        return self.loadFn(self.ptr, allocator, hash);
    }
};

/// Recursive tree diff: walks into sub-directories when their hashes differ.
/// Returns file-level changes with full paths (e.g., "src/lib/utils.zig").
/// Short-circuits on matching subtree hashes (like ripgit's diff engine).
pub fn diffTreesRecursive(
    allocator: std.mem.Allocator,
    loader: TreeLoader,
    old_tree_hash: ?sha1_mod.Digest,
    new_tree_hash: ?sha1_mod.Digest,
    prefix: []const u8,
) ![]TreeChange {
    // Short-circuit: identical trees
    if (old_tree_hash != null and new_tree_hash != null and
        std.mem.eql(u8, &old_tree_hash.?, &new_tree_hash.?))
    {
        return try allocator.alloc(TreeChange, 0);
    }

    // Load tree data
    const old_data = if (old_tree_hash) |h| try loader.load(allocator, h) else null;
    defer if (old_data) |d| allocator.free(d);
    const new_data = if (new_tree_hash) |h| try loader.load(allocator, h) else null;
    defer if (new_data) |d| allocator.free(d);

    // Get flat diff at this level
    const flat = try diffTrees(allocator, old_data, new_data);
    defer freeTreeChanges(allocator, flat);

    var result: std.ArrayList(TreeChange) = .empty;
    errdefer result.deinit(allocator);

    for (flat) |change| {
        // Build full path
        const full_path = if (prefix.len > 0)
            try std.fmt.allocPrint(allocator, "{s}/{s}", .{ prefix, change.path })
        else
            try allocator.dupe(u8, change.path);

        const is_tree_old = if (change.old_mode) |m| std.mem.eql(u8, m, "40000") else false;
        const is_tree_new = if (change.new_mode) |m| std.mem.eql(u8, m, "40000") else false;

        if (is_tree_old or is_tree_new) {
            defer allocator.free(full_path);
            // Recurse into subtrees
            const sub = try diffTreesRecursive(
                allocator,
                loader,
                if (is_tree_old) change.old_hash else null,
                if (is_tree_new) change.new_hash else null,
                full_path,
            );
            defer allocator.free(sub);
            for (sub) |s| {
                try result.append(allocator, s);
            }
        } else {
            try result.append(allocator, .{
                .kind = change.kind,
                .path = full_path,
                .old_hash = change.old_hash,
                .new_hash = change.new_hash,
                .old_mode = if (change.old_mode) |mode| try allocator.dupe(u8, mode) else null,
                .new_mode = if (change.new_mode) |mode| try allocator.dupe(u8, mode) else null,
            });
        }
    }

    return result.toOwnedSlice(allocator);
}

test "tree diff" {
    const allocator = std.testing.allocator;

    var hash_a: sha1_mod.Digest = undefined;
    @memset(&hash_a, 0xAA);
    var hash_b: sha1_mod.Digest = undefined;
    @memset(&hash_b, 0xBB);
    var hash_c: sha1_mod.Digest = undefined;
    @memset(&hash_c, 0xCC);

    // Build old tree: file_a (hash_a), file_b (hash_b)
    const old_tree = try object_mod.buildTree(allocator, &[_]object_mod.TreeEntry{
        .{ .mode = "100644", .name = "file_a.txt", .hash = hash_a },
        .{ .mode = "100644", .name = "file_b.txt", .hash = hash_b },
    });
    defer allocator.free(old_tree);

    // Build new tree: file_a (hash_a unchanged), file_b (hash_c modified), file_d (added)
    const new_tree = try object_mod.buildTree(allocator, &[_]object_mod.TreeEntry{
        .{ .mode = "100644", .name = "file_a.txt", .hash = hash_a },
        .{ .mode = "100644", .name = "file_b.txt", .hash = hash_c },
        .{ .mode = "100644", .name = "file_d.txt", .hash = hash_c },
    });
    defer allocator.free(new_tree);

    const changes = try diffTrees(allocator, old_tree, new_tree);
    defer freeTreeChanges(allocator, changes);

    try std.testing.expectEqual(@as(usize, 2), changes.len);
    try std.testing.expectEqual(TreeChangeKind.modified, changes[0].kind);
    try std.testing.expectEqualStrings("file_b.txt", changes[0].path);
    try std.testing.expectEqual(TreeChangeKind.added, changes[1].kind);
    try std.testing.expectEqualStrings("file_d.txt", changes[1].path);
}

test "recursive tree diff retains owned nested paths" {
    const allocator = std.testing.allocator;

    var blob_old: sha1_mod.Digest = undefined;
    @memset(&blob_old, 0x11);
    var blob_new: sha1_mod.Digest = undefined;
    @memset(&blob_new, 0x22);

    const old_inner_tree = try object_mod.buildTree(allocator, &[_]object_mod.TreeEntry{
        .{ .mode = "100644", .name = "file.txt", .hash = blob_old },
    });
    defer allocator.free(old_inner_tree);
    const new_inner_tree = try object_mod.buildTree(allocator, &[_]object_mod.TreeEntry{
        .{ .mode = "100644", .name = "file.txt", .hash = blob_new },
    });
    defer allocator.free(new_inner_tree);

    const old_inner_hash = object_mod.hashObjectDigest(.tree, old_inner_tree);
    const new_inner_hash = object_mod.hashObjectDigest(.tree, new_inner_tree);

    const old_root_tree = try object_mod.buildTree(allocator, &[_]object_mod.TreeEntry{
        .{ .mode = "40000", .name = "nested", .hash = old_inner_hash },
    });
    defer allocator.free(old_root_tree);
    const new_root_tree = try object_mod.buildTree(allocator, &[_]object_mod.TreeEntry{
        .{ .mode = "40000", .name = "nested", .hash = new_inner_hash },
    });
    defer allocator.free(new_root_tree);

    const Fixtures = struct {
        old_root: []const u8,
        new_root: []const u8,
        old_inner: []const u8,
        new_inner: []const u8,
        old_root_hash: sha1_mod.Digest,
        new_root_hash: sha1_mod.Digest,
        old_inner_hash: sha1_mod.Digest,
        new_inner_hash: sha1_mod.Digest,

        fn load(ptr: *anyopaque, alloc: std.mem.Allocator, hash: sha1_mod.Digest) !?[]u8 {
            const self: *@This() = @ptrCast(@alignCast(ptr));
            if (std.mem.eql(u8, &hash, &self.old_root_hash)) {
                return try alloc.dupe(u8, self.old_root);
            }
            if (std.mem.eql(u8, &hash, &self.new_root_hash)) {
                return try alloc.dupe(u8, self.new_root);
            }
            if (std.mem.eql(u8, &hash, &self.old_inner_hash)) {
                return try alloc.dupe(u8, self.old_inner);
            }
            if (std.mem.eql(u8, &hash, &self.new_inner_hash)) {
                return try alloc.dupe(u8, self.new_inner);
            }
            return null;
        }
    };

    var fixtures = Fixtures{
        .old_root = old_root_tree,
        .new_root = new_root_tree,
        .old_inner = old_inner_tree,
        .new_inner = new_inner_tree,
        .old_root_hash = object_mod.hashObjectDigest(.tree, old_root_tree),
        .new_root_hash = object_mod.hashObjectDigest(.tree, new_root_tree),
        .old_inner_hash = old_inner_hash,
        .new_inner_hash = new_inner_hash,
    };

    const changes = try diffTreesRecursive(
        allocator,
        .{
            .ptr = &fixtures,
            .loadFn = Fixtures.load,
        },
        object_mod.hashObjectDigest(.tree, old_root_tree),
        object_mod.hashObjectDigest(.tree, new_root_tree),
        "",
    );
    defer freeTreeChanges(allocator, changes);

    try std.testing.expectEqual(@as(usize, 1), changes.len);
    try std.testing.expectEqual(TreeChangeKind.modified, changes[0].kind);
    try std.testing.expectEqualStrings("nested/file.txt", changes[0].path);
}

test "diff identical" {
    const allocator = std.testing.allocator;
    const text = "hello\nworld\n";
    const diff = try diffLines(allocator, text, text);
    defer allocator.free(diff);

    try std.testing.expectEqual(@as(usize, 2), diff.len);
    try std.testing.expectEqual(DiffOp.equal, diff[0].op);
    try std.testing.expectEqual(DiffOp.equal, diff[1].op);
}

test "diff insert" {
    const allocator = std.testing.allocator;
    const a = "hello\nworld\n";
    const b = "hello\nnew\nworld\n";
    const diff = try diffLines(allocator, a, b);
    defer allocator.free(diff);

    try std.testing.expectEqual(@as(usize, 3), diff.len);
    try std.testing.expectEqual(DiffOp.equal, diff[0].op);
    try std.testing.expectEqualStrings("hello", diff[0].text);
    try std.testing.expectEqual(DiffOp.insert, diff[1].op);
    try std.testing.expectEqualStrings("new", diff[1].text);
    try std.testing.expectEqual(DiffOp.equal, diff[2].op);
}

test "diff delete" {
    const allocator = std.testing.allocator;
    const a = "hello\nremove\nworld\n";
    const b = "hello\nworld\n";
    const diff = try diffLines(allocator, a, b);
    defer allocator.free(diff);

    try std.testing.expectEqual(@as(usize, 3), diff.len);
    try std.testing.expectEqual(DiffOp.equal, diff[0].op);
    try std.testing.expectEqual(DiffOp.delete, diff[1].op);
    try std.testing.expectEqualStrings("remove", diff[1].text);
    try std.testing.expectEqual(DiffOp.equal, diff[2].op);
}

test "unified diff" {
    const allocator = std.testing.allocator;
    const a = "line1\nline2\nline3\n";
    const b = "line1\nchanged\nline3\n";
    const diff = try unifiedDiff(allocator, a, b, "file.txt", "file.txt", "a/file.txt", "b/file.txt");
    defer allocator.free(diff);

    try std.testing.expect(std.mem.indexOf(u8, diff, "diff --git a/file.txt b/file.txt") != null);
    try std.testing.expect(std.mem.indexOf(u8, diff, "--- a/file.txt") != null);
    try std.testing.expect(std.mem.indexOf(u8, diff, "+++ b/file.txt") != null);
    try std.testing.expect(std.mem.indexOf(u8, diff, "-line2") != null);
    try std.testing.expect(std.mem.indexOf(u8, diff, "+changed") != null);
}

test "unified diff uses git paths for added files" {
    const allocator = std.testing.allocator;
    const diff = try unifiedDiff(allocator, "", "new\n", "new.txt", "new.txt", "/dev/null", "b/new.txt");
    defer allocator.free(diff);

    try std.testing.expect(std.mem.indexOf(u8, diff, "diff --git a/new.txt b/new.txt") != null);
    try std.testing.expect(std.mem.indexOf(u8, diff, "--- /dev/null") != null);
    try std.testing.expect(std.mem.indexOf(u8, diff, "+++ b/new.txt") != null);
}

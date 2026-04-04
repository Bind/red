/// Commit graph walking and ancestry queries.
/// Needed for: rev-list, merge-base, push validation, fetch negotiation.
///
/// Walks commit graph via a callback-based object loader, so it works
/// with any storage backend (disk, S3, SQLite, pack files).
const std = @import("std");
const sha1_mod = @import("sha1.zig");
const object = @import("object.zig");

/// Result of loading a git object.
pub const LoadedObject = struct {
    obj_type: object.ObjectType,
    data: []u8,
};

/// Callback type for loading a raw git object by hash.
/// Returns the object data (caller frees), or null if not found.
pub const ObjectLoader = struct {
    ptr: *anyopaque,
    loadFn: *const fn (ptr: *anyopaque, allocator: std.mem.Allocator, hash: [40]u8) anyerror!?LoadedObject,

    pub fn load(self: ObjectLoader, allocator: std.mem.Allocator, hash: [40]u8) !?LoadedObject {
        return self.loadFn(self.ptr, allocator, hash);
    }
};

/// Walk commits reachable from `tips`, stopping at `stops`.
/// Returns commit hashes in reverse chronological order (newest first).
/// This is the core of `git rev-list tips ^stops`.
pub fn revList(
    allocator: std.mem.Allocator,
    loader: ObjectLoader,
    tips: []const [40]u8,
    stops: []const [40]u8,
) ![][40]u8 {
    var visited = std.AutoHashMap([40]u8, void).init(allocator);
    defer visited.deinit();

    // Mark stops as visited
    for (stops) |s| {
        try visited.put(s, {});
    }

    // BFS from tips
    var queue: std.ArrayList([40]u8) = .empty;
    defer queue.deinit(allocator);
    var result: std.ArrayList([40]u8) = .empty;
    errdefer result.deinit(allocator);

    for (tips) |t| {
        if (!visited.contains(t)) {
            try queue.append(allocator, t);
        }
    }

    while (queue.items.len > 0) {
        const hash = queue.orderedRemove(0); // FIFO for BFS
        if (visited.contains(hash)) continue;
        try visited.put(hash, {});
        try result.append(allocator, hash);

        // Load commit and enqueue parents
        const obj = try loader.load(allocator, hash) orelse continue;
        defer allocator.free(obj.data);

        if (obj.obj_type != .commit) continue;

        const info = object.parseCommit(allocator, obj.data) catch continue;
        defer allocator.free(info.parents);

        for (info.parents) |parent| {
            if (!visited.contains(parent)) {
                try queue.append(allocator, parent);
            }
        }
    }

    return result.toOwnedSlice(allocator);
}

/// Check if `ancestor` is reachable from `descendant`.
/// Used for push validation (fast-forward check).
pub fn isAncestor(
    allocator: std.mem.Allocator,
    loader: ObjectLoader,
    ancestor: [40]u8,
    descendant: [40]u8,
) !bool {
    if (std.mem.eql(u8, &ancestor, &descendant)) return true;

    var visited = std.AutoHashMap([40]u8, void).init(allocator);
    defer visited.deinit();

    var queue: std.ArrayList([40]u8) = .empty;
    defer queue.deinit(allocator);
    try queue.append(allocator, descendant);

    while (queue.items.len > 0) {
        const hash = queue.pop() orelse break;
        if (std.mem.eql(u8, &hash, &ancestor)) return true;
        if (visited.contains(hash)) continue;
        try visited.put(hash, {});

        const obj = try loader.load(allocator, hash) orelse continue;
        defer allocator.free(obj.data);

        if (obj.obj_type != .commit) continue;

        const info = object.parseCommit(allocator, obj.data) catch continue;
        defer allocator.free(info.parents);

        for (info.parents) |parent| {
            if (!visited.contains(parent)) {
                try queue.append(allocator, parent);
            }
        }
    }

    return false;
}

/// Collect all object hashes reachable from a set of commits.
/// Returns hashes of commits, trees, and blobs.
/// Used for building the set of objects to send in upload-pack.
pub fn collectReachableObjects(
    allocator: std.mem.Allocator,
    loader: ObjectLoader,
    tips: []const [40]u8,
    stops: []const [40]u8,
) ![][40]u8 {
    // First get reachable commits
    const commits = try revList(allocator, loader, tips, stops);
    defer allocator.free(commits);

    var all_objects = std.AutoHashMap([40]u8, void).init(allocator);
    defer all_objects.deinit();

    var queue: std.ArrayList([40]u8) = .empty;
    defer queue.deinit(allocator);

    // Add all commits and their trees
    for (commits) |commit_hash| {
        try all_objects.put(commit_hash, {});

        const obj = try loader.load(allocator, commit_hash) orelse continue;
        defer allocator.free(obj.data);

        const info = object.parseCommit(allocator, obj.data) catch continue;
        defer allocator.free(info.parents);

        try queue.append(allocator, info.tree_hash);
    }

    // Walk trees to collect all tree and blob hashes
    while (queue.items.len > 0) {
        const hash = queue.pop() orelse break;
        if (all_objects.contains(hash)) continue;
        try all_objects.put(hash, {});

        const obj = try loader.load(allocator, hash) orelse continue;
        defer allocator.free(obj.data);

        if (obj.obj_type == .tree) {
            const entries = object.parseTree(allocator, obj.data) catch continue;
            defer allocator.free(entries);

            for (entries) |entry| {
                const entry_hex = sha1_mod.digestToHex(&entry.hash);
                if (!all_objects.contains(entry_hex)) {
                    try queue.append(allocator, entry_hex);
                }
            }
        }
    }

    // Convert to sorted slice
    var result: std.ArrayList([40]u8) = .empty;
    errdefer result.deinit(allocator);

    var iter = all_objects.keyIterator();
    while (iter.next()) |key| {
        try result.append(allocator, key.*);
    }

    return result.toOwnedSlice(allocator);
}

/// Find the merge-base (lowest common ancestor) of two commits.
/// Returns the hash of the merge-base commit, or null if none exists
/// (i.e., the commits are on disjoint histories).
///
/// Algorithm: simultaneous BFS from both commits. When one BFS reaches
/// a commit already visited by the other, that's the merge-base.
pub fn mergeBase(
    allocator: std.mem.Allocator,
    loader: ObjectLoader,
    commit_a: [40]u8,
    commit_b: [40]u8,
) !?[40]u8 {
    if (std.mem.eql(u8, &commit_a, &commit_b)) return commit_a;

    const SIDE_A: u2 = 1;
    const SIDE_B: u2 = 2;

    // Track which side(s) have visited each commit
    var visited = std.AutoHashMap([40]u8, u2).init(allocator);
    defer visited.deinit();

    var queue_a: std.ArrayList([40]u8) = .empty;
    defer queue_a.deinit(allocator);
    var queue_b: std.ArrayList([40]u8) = .empty;
    defer queue_b.deinit(allocator);

    try queue_a.append(allocator, commit_a);
    try queue_b.append(allocator, commit_b);
    try visited.put(commit_a, SIDE_A);
    try visited.put(commit_b, SIDE_B);

    // Alternate BFS steps between sides
    while (queue_a.items.len > 0 or queue_b.items.len > 0) {
        // Step side A
        if (queue_a.items.len > 0) {
            const hash = queue_a.orderedRemove(0);
            const parents = try getParents(allocator, loader, hash);
            defer allocator.free(parents);
            for (parents) |parent| {
                const gop = try visited.getOrPut(parent);
                if (gop.found_existing) {
                    if (gop.value_ptr.* & SIDE_A == 0) {
                        // Already visited by side B — merge-base found!
                        return parent;
                    }
                } else {
                    gop.value_ptr.* = SIDE_A;
                    try queue_a.append(allocator, parent);
                }
            }
        }

        // Step side B
        if (queue_b.items.len > 0) {
            const hash = queue_b.orderedRemove(0);
            const parents = try getParents(allocator, loader, hash);
            defer allocator.free(parents);
            for (parents) |parent| {
                const gop = try visited.getOrPut(parent);
                if (gop.found_existing) {
                    if (gop.value_ptr.* & SIDE_B == 0) {
                        // Already visited by side A — merge-base found!
                        return parent;
                    }
                } else {
                    gop.value_ptr.* = SIDE_B;
                    try queue_b.append(allocator, parent);
                }
            }
        }
    }

    return null; // Disjoint histories
}

/// Helper: get parent commit hashes.
fn getParents(allocator: std.mem.Allocator, loader: ObjectLoader, hash: [40]u8) ![]const [40]u8 {
    const empty: []const [40]u8 = &.{};
    const obj = try loader.load(allocator, hash) orelse return empty;
    defer allocator.free(obj.data);
    if (obj.obj_type != .commit) return empty;
    const info = object.parseCommit(allocator, obj.data) catch return empty;
    return info.parents; // caller owns
}

// No tests here to avoid circular imports — tested via integration tests.

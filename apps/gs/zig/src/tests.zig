/// Comprehensive test suite for libgitty.
/// Tests real git compatibility — hashes, formats, roundtrips.
const std = @import("std");
const sha1_mod = @import("sha1.zig");
const zlib = @import("deflate.zig");
const object = @import("object.zig");
const delta = @import("delta.zig");
const pack = @import("pack.zig");
const packindex = @import("packindex.zig");
const protocol = @import("protocol.zig");
const diff_mod = @import("diff.zig");

// ════════════════════ SHA-1 ════════════════════

test "sha1: matches git hash-object for blob" {
    // echo -n "hello" | git hash-object --stdin = b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0
    const hash = object.hashObject(.blob, "hello");
    try std.testing.expectEqualStrings("b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0", &hash);
}

test "sha1: matches git for blob with newline" {
    // echo "hello" | git hash-object --stdin = ce013625030ba8dba906f756967f9e9ca394464a
    const hash = object.hashObject(.blob, "hello\n");
    try std.testing.expectEqualStrings("ce013625030ba8dba906f756967f9e9ca394464a", &hash);
}

test "sha1: empty blob" {
    // git hash-object -t blob --stdin < /dev/null = e69de29bb2d1d6434b8b29ae775ad8c2e48c5391
    const hash = object.hashObject(.blob, "");
    try std.testing.expectEqualStrings("e69de29bb2d1d6434b8b29ae775ad8c2e48c5391", &hash);
}

test "sha1: empty tree" {
    // git mktree < /dev/null = 4b825dc642cb6eb9a060e54bf8d69288fbee4904
    const hash = object.hashObject(.tree, "");
    try std.testing.expectEqualStrings("4b825dc642cb6eb9a060e54bf8d69288fbee4904", &hash);
}

test "sha1: hex roundtrip" {
    const original = sha1_mod.Sha1.hash("test data");
    const hex = sha1_mod.digestToHex(&original);
    const restored = try sha1_mod.hexToDigest(&hex);
    try std.testing.expectEqualSlices(u8, &original, &restored);
}

// ════════════════════ Zlib ════════════════════

test "zlib: various sizes" {
    const a = std.testing.allocator;
    const sizes = [_]usize{ 0, 1, 10, 100, 1000, 10000, 65535, 100000 };
    for (sizes) |size| {
        const data = try a.alloc(u8, size);
        defer a.free(data);
        for (data, 0..) |*b, i| b.* = @intCast(i % 256);

        const compressed = try zlib.deflate(a, data);
        defer a.free(compressed);
        const decompressed = try zlib.inflate(a, compressed);
        defer a.free(decompressed);
        try std.testing.expectEqualSlices(u8, data, decompressed);
    }
}

test "zlib: inflateWithSize precise" {
    const a = std.testing.allocator;
    // Create 3 compressed streams back-to-back
    const d1 = try zlib.deflate(a, "first");
    defer a.free(d1);
    const d2 = try zlib.deflate(a, "second");
    defer a.free(d2);

    // Concatenate
    const combined = try a.alloc(u8, d1.len + d2.len);
    defer a.free(combined);
    @memcpy(combined[0..d1.len], d1);
    @memcpy(combined[d1.len..], d2);

    // inflateWithSize should stop at first stream boundary
    const r1 = try zlib.inflateWithSize(a, combined);
    defer a.free(r1.data);
    try std.testing.expectEqualStrings("first", r1.data);
    try std.testing.expectEqual(d1.len, r1.compressed_size);

    // Second stream starts where first ended
    const r2 = try zlib.inflateWithSize(a, combined[r1.compressed_size..]);
    defer a.free(r2.data);
    try std.testing.expectEqualStrings("second", r2.data);
}

// ════════════════════ Objects ════════════════════

test "object: tree with multiple entry types" {
    const a = std.testing.allocator;
    const blob_hash = sha1_mod.Sha1.hash("blob content");
    const tree_hash = sha1_mod.Sha1.hash("tree content");

    const entries = [_]object.TreeEntry{
        .{ .mode = "100644", .name = "file.txt", .hash = blob_hash },
        .{ .mode = "100755", .name = "script.sh", .hash = blob_hash },
        .{ .mode = "120000", .name = "link", .hash = blob_hash },
        .{ .mode = "40000", .name = "subdir", .hash = tree_hash },
    };

    const tree_data = try object.buildTree(a, &entries);
    defer a.free(tree_data);

    const parsed = try object.parseTree(a, tree_data);
    defer a.free(parsed);

    try std.testing.expectEqual(@as(usize, 4), parsed.len);
    try std.testing.expectEqualStrings("100644", parsed[0].mode);
    try std.testing.expectEqualStrings("file.txt", parsed[0].name);
    try std.testing.expectEqualStrings("100755", parsed[1].mode);
    try std.testing.expectEqualStrings("120000", parsed[2].mode);
    try std.testing.expectEqualStrings("40000", parsed[3].mode);
}

test "object: commit with multiple parents (merge commit)" {
    const a = std.testing.allocator;
    const tree: [40]u8 = .{'a'} ** 40;
    const p1: [40]u8 = .{'b'} ** 40;
    const p2: [40]u8 = .{'c'} ** 40;

    const data = try object.buildCommit(a, tree, &.{ p1, p2 }, "A <a@b.c> 1 +0000", "A <a@b.c> 1 +0000", "Merge\n");
    defer a.free(data);

    const info = try object.parseCommit(a, data);
    defer a.free(info.parents);

    try std.testing.expectEqual(@as(usize, 2), info.parents.len);
    try std.testing.expectEqualStrings(&p1, &info.parents[0]);
    try std.testing.expectEqualStrings(&p2, &info.parents[1]);
    try std.testing.expectEqualStrings("Merge\n", info.message);
}

test "object: tag roundtrip" {
    const a = std.testing.allocator;
    const hash: [40]u8 = .{'d'} ** 40;

    const data = try object.buildTag(a, hash, .commit, "v1.0", "T <t@t> 1 +0000", "Release 1.0\n");
    defer a.free(data);

    const info = object.parseTag(data);
    try std.testing.expectEqualStrings(&hash, &info.object_hash);
    try std.testing.expectEqualStrings("commit", info.object_type);
    try std.testing.expectEqualStrings("v1.0", info.tag_name);
    try std.testing.expectEqualStrings("Release 1.0\n", info.message);
}

test "object: encode/decode preserves type and content" {
    const a = std.testing.allocator;
    const types = [_]object.ObjectType{ .blob, .commit, .tree };
    for (types) |t| {
        const data = "test content for type";
        const encoded = try object.encodeObject(a, t, data);
        defer a.free(encoded);
        const decoded = try object.decodeObject(a, encoded);
        defer a.free(decoded.data);
        try std.testing.expectEqual(t, decoded.obj_type);
        try std.testing.expectEqualStrings(data, decoded.data);
    }
}

// ════════════════════ Delta ════════════════════

test "delta: large similar files" {
    const a = std.testing.allocator;
    // Simulate editing a source file: mostly the same, one line changed
    const base = "line1\nline2\nline3\nline4\nline5\n" ** 100;
    const target = "line1\nline2\nMODIFIED\nline4\nline5\n" ** 100;

    const d = try delta.createDelta(a, base, target);
    defer a.free(d);

    // Delta should be much smaller than full target
    try std.testing.expect(d.len < target.len / 2);

    const result = try delta.applyDelta(a, base, d);
    defer a.free(result);
    try std.testing.expectEqualStrings(target, result);
}

test "delta: binary data" {
    const a = std.testing.allocator;
    var base: [1024]u8 = undefined;
    var target: [1024]u8 = undefined;
    for (&base, 0..) |*b, i| b.* = @intCast(i % 256);
    @memcpy(&target, &base);
    target[512] = 0xFF; // Change one byte

    const d = try delta.createDelta(a, &base, &target);
    defer a.free(d);
    const result = try delta.applyDelta(a, &base, d);
    defer a.free(result);
    try std.testing.expectEqualSlices(u8, &target, result);
}

// ════════════════════ Pack ════════════════════

test "pack: multiple object types" {
    const a = std.testing.allocator;

    const blob_data = "file content\n";
    const tree_data = try object.buildTree(a, &.{
        .{ .mode = "100644", .name = "file", .hash = sha1_mod.Sha1.hash(blob_data) },
    });
    defer a.free(tree_data);

    const objects = [_]pack.PackObject{
        .{ .obj_type = .blob, .hash = object.hashObject(.blob, blob_data), .data = blob_data },
        .{ .obj_type = .tree, .hash = object.hashObject(.tree, tree_data), .data = tree_data },
    };

    const pd = try pack.buildPack(a, &objects);
    defer a.free(pd);

    const entries = try pack.parsePack(a, pd);
    defer {
        for (entries) |*e| @constCast(e).deinit(a);
        a.free(entries);
    }

    try std.testing.expectEqual(@as(usize, 2), entries.len);
    try std.testing.expectEqual(object.ObjectType.blob, entries[0].obj_type);
    try std.testing.expectEqual(object.ObjectType.tree, entries[1].obj_type);

    // Verify hashes
    try std.testing.expectEqualStrings(&objects[0].hash, &entries[0].hash);
    try std.testing.expectEqualStrings(&objects[1].hash, &entries[1].hash);
}

test "pack: buildPackDelta produces valid OFS_DELTA" {
    const a = std.testing.allocator;

    // Create objects that should deltify well
    const base_content = "shared prefix " ** 50 ++ "unique-base-suffix\n";
    const delta_content = "shared prefix " ** 50 ++ "unique-delta-suffix\n";

    const objects = [_]pack.PackObject{
        .{ .obj_type = .blob, .hash = object.hashObject(.blob, base_content), .data = base_content },
        .{ .obj_type = .blob, .hash = object.hashObject(.blob, delta_content), .data = delta_content },
    };

    const pd = try pack.buildPackDelta(a, &objects);
    defer a.free(pd);

    const entries = try pack.parsePack(a, pd);
    defer {
        for (entries) |*e| @constCast(e).deinit(a);
        a.free(entries);
    }

    try std.testing.expectEqual(@as(usize, 2), entries.len);
    try std.testing.expectEqualStrings(base_content, entries[0].data);
    try std.testing.expectEqualStrings(delta_content, entries[1].data);

    // Delta pack should be smaller than non-delta
    const pd_nodelta = try pack.buildPack(a, &objects);
    defer a.free(pd_nodelta);
    try std.testing.expect(pd.len < pd_nodelta.len);
}

test "pack: indexPack counts correctly" {
    const a = std.testing.allocator;
    const objects = [_]pack.PackObject{
        .{ .obj_type = .blob, .hash = object.hashObject(.blob, "a"), .data = "a" },
        .{ .obj_type = .blob, .hash = object.hashObject(.blob, "b"), .data = "b" },
        .{ .obj_type = .blob, .hash = object.hashObject(.blob, "c"), .data = "c" },
    };

    const pd = try pack.buildPack(a, &objects);
    defer a.free(pd);

    const meta = try pack.indexPack(a, pd);
    defer a.free(meta);

    try std.testing.expectEqual(@as(usize, 3), meta.len);
    for (meta) |m| {
        try std.testing.expect(m.type_num >= 1 and m.type_num <= 4);
    }
}

// ════════════════════ Pack Index ════════════════════

test "packindex: large index roundtrip" {
    const a = std.testing.allocator;

    // Create 100 entries with realistic hashes
    var entries: [100]packindex.IndexEntry = undefined;
    for (&entries, 0..) |*e, i| {
        var data_buf: [8]u8 = undefined;
        std.mem.writeInt(u64, &data_buf, i, .big);
        e.hash = sha1_mod.Sha1.hash(&data_buf);
        e.crc32 = @intCast(i * 7);
        e.offset = i * 1000;
    }

    var cksum: sha1_mod.Digest = undefined;
    @memset(&cksum, 0);

    const idx_data = try packindex.buildIndex(a, &entries, cksum);
    defer a.free(idx_data);

    const idx = try packindex.PackIndex.init(idx_data);
    try std.testing.expectEqual(@as(u32, 100), idx.objectCount());

    // Verify all lookups
    for (entries) |e| {
        const offset = idx.lookup(&e.hash);
        try std.testing.expect(offset != null);
        try std.testing.expectEqual(e.offset, offset.?);
    }

    // Verify missing hash returns null
    var missing: sha1_mod.Digest = undefined;
    @memset(&missing, 0xFF);
    try std.testing.expectEqual(@as(?u64, null), idx.lookup(&missing));
}

// ════════════════════ Protocol ════════════════════

test "protocol: capabilities parsing" {
    const caps = protocol.parseCapabilities("report-status side-band-64k ofs-delta thin-pack multi_ack no-done");
    try std.testing.expect(caps.report_status);
    try std.testing.expect(caps.side_band_64k);
    try std.testing.expect(caps.ofs_delta);
    try std.testing.expect(caps.thin_pack);
    try std.testing.expect(caps.multi_ack);
    try std.testing.expect(caps.no_done);
    try std.testing.expect(!caps.side_band);
    try std.testing.expect(!caps.include_tag);
}

test "protocol: symbolic ref parsing" {
    try std.testing.expectEqualStrings("refs/heads/main", protocol.parseSymbolicRef("ref: refs/heads/main\n").?);
    try std.testing.expectEqualStrings("refs/heads/dev", protocol.parseSymbolicRef("ref: refs/heads/dev").?);
    try std.testing.expectEqual(@as(?[]const u8, null), protocol.parseSymbolicRef("abc123\n"));
}

test "protocol: pktLineAppend" {
    const a = std.testing.allocator;
    var buf: std.ArrayList(u8) = .empty;
    defer buf.deinit(a);

    try protocol.pktLineAppend(a, &buf, "# service=git-upload-pack\n");
    try protocol.pktLineAppend(a, &buf, "hello\n");

    try std.testing.expect(std.mem.startsWith(u8, buf.items, "001e# service=git-upload-pack\n"));
}

// ════════════════════ Diff ════════════════════

test "diff: modify + add + delete" {
    const a = std.testing.allocator;
    const old = "keep1\ndelete\nkeep2\nold\nkeep3\n";
    const new = "keep1\nkeep2\nnew\nkeep3\nadded\n";

    const d = try diff_mod.diffLines(a, old, new);
    defer a.free(d);

    var inserts: usize = 0;
    var deletes: usize = 0;
    var equals: usize = 0;
    for (d) |line| switch (line.op) {
        .insert => inserts += 1,
        .delete => deletes += 1,
        .equal => equals += 1,
    };

    try std.testing.expectEqual(@as(usize, 3), equals); // keep1, keep2, keep3
    try std.testing.expectEqual(@as(usize, 2), inserts); // new, added
    try std.testing.expectEqual(@as(usize, 2), deletes); // delete, old
}

test "diff: unified format has correct markers" {
    const a = std.testing.allocator;
    const u = try diff_mod.unifiedDiff(a, "old\n", "new\n", "a/f.txt", "b/f.txt");
    defer a.free(u);

    try std.testing.expect(std.mem.indexOf(u8, u, "--- a/f.txt") != null);
    try std.testing.expect(std.mem.indexOf(u8, u, "+++ b/f.txt") != null);
    try std.testing.expect(std.mem.indexOf(u8, u, "-old") != null);
    try std.testing.expect(std.mem.indexOf(u8, u, "+new") != null);
    try std.testing.expect(std.mem.indexOf(u8, u, "@@") != null);
}

test "diff: tree diff detects all change types" {
    const a = std.testing.allocator;
    var h1: sha1_mod.Digest = undefined;
    @memset(&h1, 0x11);
    var h2: sha1_mod.Digest = undefined;
    @memset(&h2, 0x22);

    const old = try object.buildTree(a, &.{
        .{ .mode = "100644", .name = "deleted.txt", .hash = h1 },
        .{ .mode = "100644", .name = "modified.txt", .hash = h1 },
        .{ .mode = "100644", .name = "unchanged.txt", .hash = h1 },
    });
    defer a.free(old);

    const new = try object.buildTree(a, &.{
        .{ .mode = "100644", .name = "added.txt", .hash = h2 },
        .{ .mode = "100644", .name = "modified.txt", .hash = h2 },
        .{ .mode = "100644", .name = "unchanged.txt", .hash = h1 },
    });
    defer a.free(new);

    const changes = try diff_mod.diffTrees(a, old, new);
    defer diff_mod.freeTreeChanges(a, changes);

    try std.testing.expectEqual(@as(usize, 3), changes.len);
    // Sorted by name: added, deleted, modified
    try std.testing.expectEqual(diff_mod.TreeChangeKind.added, changes[0].kind);
    try std.testing.expectEqualStrings("added.txt", changes[0].path);
    try std.testing.expectEqual(diff_mod.TreeChangeKind.deleted, changes[1].kind);
    try std.testing.expectEqualStrings("deleted.txt", changes[1].path);
    try std.testing.expectEqual(diff_mod.TreeChangeKind.modified, changes[2].kind);
    try std.testing.expectEqualStrings("modified.txt", changes[2].path);
}

// ════════════════════ Integration ════════════════════

test "integration: full object lifecycle" {
    const a = std.testing.allocator;

    // 1. Create a blob
    const blob_content = "Hello, libgitty!\n";
    const blob_hash = object.hashObject(.blob, blob_content);

    // 2. Encode it (zlib compress)
    const encoded = try object.encodeObject(a, .blob, blob_content);
    defer a.free(encoded);

    // 3. Decode it back
    const decoded = try object.decodeObject(a, encoded);
    defer a.free(decoded.data);
    try std.testing.expectEqualStrings(blob_content, decoded.data);

    // 4. Verify hash of decoded matches original
    const rehash = object.hashObject(decoded.obj_type, decoded.data);
    try std.testing.expectEqualStrings(&blob_hash, &rehash);

    // 5. Put in a pack
    const objects = [_]pack.PackObject{
        .{ .obj_type = .blob, .hash = blob_hash, .data = blob_content },
    };
    const pd = try pack.buildPack(a, &objects);
    defer a.free(pd);

    // 6. Parse the pack
    const entries = try pack.parsePack(a, pd);
    defer {
        for (entries) |*e| @constCast(e).deinit(a);
        a.free(entries);
    }
    try std.testing.expectEqualStrings(&blob_hash, &entries[0].hash);
    try std.testing.expectEqualStrings(blob_content, entries[0].data);
}

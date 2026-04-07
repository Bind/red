const std = @import("std");
const protocol = @import("protocol.zig");

pub const MinioStorage = struct {
    allocator: std.mem.Allocator,
    io: std.Io,
    endpoint: []const u8,
    bucket: []const u8,
    prefix_root: []const u8,
    region: []const u8,
    access_key_id: []const u8,
    secret_access_key: []const u8,
    repo_id: []const u8,

    pub fn init(allocator: std.mem.Allocator, io: std.Io, repo_id: []const u8) !MinioStorage {
        return .{
            .allocator = allocator,
            .io = io,
            .endpoint = try dupEnvOwned(allocator, "GIT_SERVER_S3_ENDPOINT"),
            .bucket = try dupEnvOwned(allocator, "GIT_SERVER_S3_BUCKET"),
            .prefix_root = try dupEnvOwned(allocator, "GIT_SERVER_S3_PREFIX"),
            .region = try dupEnvOwned(allocator, "GIT_SERVER_S3_REGION"),
            .access_key_id = try dupEnvOwned(allocator, "GIT_SERVER_S3_ACCESS_KEY_ID"),
            .secret_access_key = try dupEnvOwned(allocator, "GIT_SERVER_S3_SECRET_ACCESS_KEY"),
            .repo_id = try allocator.dupe(u8, repo_id),
        };
    }

    pub fn deinit(self: *MinioStorage) void {
        self.allocator.free(self.endpoint);
        self.allocator.free(self.bucket);
        self.allocator.free(self.prefix_root);
        self.allocator.free(self.region);
        self.allocator.free(self.access_key_id);
        self.allocator.free(self.secret_access_key);
        self.allocator.free(self.repo_id);
    }

    pub fn getObject(self: *MinioStorage, allocator: std.mem.Allocator, hash: []const u8) !?[]u8 {
        const key = try self.repoObjectKey(allocator, hash);
        defer allocator.free(key);
        return self.getKeyBytes(allocator, key);
    }

    pub fn putObject(self: *MinioStorage, hash: []const u8, data: []const u8) !void {
        const key = try self.repoObjectKey(self.allocator, hash);
        defer self.allocator.free(key);
        try self.putKeyBytes(key, data, "application/octet-stream");
    }

    pub fn getRef(self: *MinioStorage, allocator: std.mem.Allocator, name: []const u8) !?[]u8 {
        const key = try self.repoRefKey(allocator, name);
        defer allocator.free(key);
        const bytes = try self.getKeyBytes(allocator, key) orelse return null;
        const trimmed = std.mem.trim(u8, bytes, "\r\n ");
        if (trimmed.len == bytes.len) return bytes;
        const copy = try allocator.dupe(u8, trimmed);
        allocator.free(bytes);
        return copy;
    }

    pub fn setRef(self: *MinioStorage, name: []const u8, hash: []const u8) !void {
        const key = try self.repoRefKey(self.allocator, name);
        defer self.allocator.free(key);
        const payload = try std.fmt.allocPrint(self.allocator, "{s}\n", .{hash});
        defer self.allocator.free(payload);
        try self.putKeyBytes(key, payload, "text/plain");
    }

    pub fn deleteRef(self: *MinioStorage, name: []const u8) !void {
        const key = try self.repoRefKey(self.allocator, name);
        defer self.allocator.free(key);
        try self.deleteKey(key);
    }

    pub fn listRefs(self: *MinioStorage, allocator: std.mem.Allocator) ![]protocol.Ref {
        var result: std.ArrayList(protocol.Ref) = .empty;
        errdefer result.deinit(allocator);

        const prefix = try self.repoRefPrefix(allocator);
        defer allocator.free(prefix);
        const keys = try self.listKeys(allocator, prefix);
        defer {
            for (keys) |key| allocator.free(key);
            allocator.free(keys);
        }

        for (keys) |key| {
            const hash = try self.getKeyBytes(allocator, key) orelse continue;
            const trimmed = std.mem.trim(u8, hash, "\r\n ");
            const hash_copy = if (trimmed.len == hash.len)
                hash
            else blk: {
                const dupe = try allocator.dupe(u8, trimmed);
                allocator.free(hash);
                break :blk dupe;
            };
            const ref_name = try allocator.dupe(u8, key[prefix.len - "refs/".len ..]);
            try result.append(allocator, .{
                .name = ref_name,
                .hash = hash_copy,
            });
        }

        return result.toOwnedSlice(allocator);
    }

    pub fn adapter(self: *MinioStorage) protocol.StorageAdapter {
        return .{
            .ptr = @ptrCast(self),
            .vtable = &vtable,
        };
    }

    const vtable: protocol.StorageAdapter.VTable = .{
        .getObject = getObjectVtable,
        .putObject = putObjectVtable,
        .getRef = getRefVtable,
        .setRef = setRefVtable,
        .deleteRef = deleteRefVtable,
        .listRefs = listRefsVtable,
    };

    const CurlResult = struct {
        stdout: []u8,
        stderr: []u8,
        success: bool,
    };

    fn getObjectVtable(ptr: *anyopaque, allocator: std.mem.Allocator, hash: []const u8) anyerror!?[]u8 {
        const self: *MinioStorage = @ptrCast(@alignCast(ptr));
        return self.getObject(allocator, hash);
    }

    fn putObjectVtable(ptr: *anyopaque, hash: []const u8, data: []const u8) anyerror!void {
        const self: *MinioStorage = @ptrCast(@alignCast(ptr));
        return self.putObject(hash, data);
    }

    fn getRefVtable(ptr: *anyopaque, allocator: std.mem.Allocator, name: []const u8) anyerror!?[]u8 {
        const self: *MinioStorage = @ptrCast(@alignCast(ptr));
        return self.getRef(allocator, name);
    }

    fn setRefVtable(ptr: *anyopaque, name: []const u8, hash: []const u8) anyerror!void {
        const self: *MinioStorage = @ptrCast(@alignCast(ptr));
        return self.setRef(name, hash);
    }

    fn deleteRefVtable(ptr: *anyopaque, name: []const u8) anyerror!void {
        const self: *MinioStorage = @ptrCast(@alignCast(ptr));
        return self.deleteRef(name);
    }

    fn listRefsVtable(ptr: *anyopaque, allocator: std.mem.Allocator) anyerror![]protocol.Ref {
        const self: *MinioStorage = @ptrCast(@alignCast(ptr));
        return self.listRefs(allocator);
    }

    fn runCurl(self: *MinioStorage, allocator: std.mem.Allocator, argv: []const []const u8, stdin_bytes: ?[]const u8) !CurlResult {
        var child = try std.process.spawn(self.io, .{
            .argv = argv,
            .stdin = .pipe,
            .stdout = .pipe,
            .stderr = .pipe,
        });
        defer child.kill(self.io);

        if (stdin_bytes) |bytes| {
            child.stdin.?.writeStreamingAll(self.io, bytes) catch {
                return error.StorageWriteFailed;
            };
            child.stdin.?.close(self.io);
            child.stdin = null;
        } else {
            child.stdin.?.close(self.io);
            child.stdin = null;
        }

        var multi_reader_buffer: std.Io.File.MultiReader.Buffer(2) = undefined;
        var multi_reader: std.Io.File.MultiReader = undefined;
        multi_reader.init(allocator, self.io, multi_reader_buffer.toStreams(), &.{ child.stdout.?, child.stderr.? });
        defer multi_reader.deinit();

        while (multi_reader.fill(64, .none)) |_| {} else |err| switch (err) {
            error.EndOfStream => {},
            else => return err,
        }

        try multi_reader.checkAnyError();

        const stdout = try multi_reader.toOwnedSlice(0);
        errdefer allocator.free(stdout);
        const stderr = try multi_reader.toOwnedSlice(1);
        errdefer allocator.free(stderr);

        return .{
            .stdout = stdout,
            .stderr = stderr,
            .success = isSuccess(try child.wait(self.io)),
        };
    }

    fn getKeyBytes(self: *MinioStorage, allocator: std.mem.Allocator, key: []const u8) !?[]u8 {
        const url = try self.objectUrl(allocator, key);
        defer allocator.free(url);

        const sigv4 = try std.fmt.allocPrint(allocator, "aws:amz:{s}:s3", .{self.region});
        defer allocator.free(sigv4);
        std.debug.print("[minio] creds access={s} secret={s}\n", .{ self.access_key_id, self.secret_access_key });
        const user = try std.fmt.allocPrint(allocator, "{s}:{s}", .{ self.access_key_id, self.secret_access_key });
        defer allocator.free(user);
        std.debug.print("[minio] GET url={s} user={s}\n", .{ url, user });

        const argv = [_][]const u8{
            "curl",
            "-fsS",
            "--aws-sigv4",
            sigv4,
            "--user",
            user,
            "-X",
            "GET",
            url,
        };
        const result = try self.runCurl(allocator, &argv, null);
        errdefer allocator.free(result.stdout);
        defer allocator.free(result.stderr);
        if (!result.success) {
            std.debug.print("[minio] getKeyBytes key={s} stderr={s}\n", .{ key, result.stderr });
            if (looksMissing(result.stderr)) {
                allocator.free(result.stdout);
                return null;
            }
            return error.StorageReadFailed;
        }
        return result.stdout;
    }

    fn putKeyBytes(self: *MinioStorage, key: []const u8, data: []const u8, content_type: []const u8) !void {
        const allocator = self.allocator;
        const url = try self.objectUrl(allocator, key);
        defer allocator.free(url);
        const sigv4 = try std.fmt.allocPrint(allocator, "aws:amz:{s}:s3", .{self.region});
        defer allocator.free(sigv4);
        const user = try std.fmt.allocPrint(allocator, "{s}:{s}", .{ self.access_key_id, self.secret_access_key });
        defer allocator.free(user);
        std.debug.print("[minio] PUT url={s} user={s}\n", .{ url, user });
        const content_header = try std.fmt.allocPrint(allocator, "Content-Type: {s}", .{content_type});
        defer allocator.free(content_header);

        const argv = [_][]const u8{
            "curl",
            "-fsS",
            "--aws-sigv4",
            sigv4,
            "--user",
            user,
            "-X",
            "PUT",
            "-H",
            content_header,
            "--data-binary",
            "@-",
            url,
        };
        const result = try self.runCurl(allocator, &argv, data);
        defer allocator.free(result.stdout);
        defer allocator.free(result.stderr);
        if (!result.success) {
            return error.StorageWriteFailed;
        }
    }

    fn deleteKey(self: *MinioStorage, key: []const u8) !void {
        const allocator = self.allocator;
        const url = try self.objectUrl(allocator, key);
        defer allocator.free(url);
        const sigv4 = try std.fmt.allocPrint(allocator, "aws:amz:{s}:s3", .{self.region});
        defer allocator.free(sigv4);
        const user = try std.fmt.allocPrint(allocator, "{s}:{s}", .{ self.access_key_id, self.secret_access_key });
        defer allocator.free(user);
        std.debug.print("[minio] DELETE url={s} user={s}\n", .{ url, user });

        const argv = [_][]const u8{
            "curl",
            "-fsS",
            "--aws-sigv4",
            sigv4,
            "--user",
            user,
            "-X",
            "DELETE",
            url,
        };
        const result = try self.runCurl(allocator, &argv, null);
        defer allocator.free(result.stdout);
        defer allocator.free(result.stderr);
        if (!result.success and !looksMissing(result.stderr)) {
            return error.StorageDeleteFailed;
        }
    }

    fn listKeys(self: *MinioStorage, allocator: std.mem.Allocator, prefix: []const u8) ![][]u8 {
        var keys: std.ArrayList([]u8) = .empty;
        errdefer {
            for (keys.items) |key| allocator.free(key);
            keys.deinit(allocator);
        }

        var continuation_token: ?[]u8 = null;
        defer if (continuation_token) |token| allocator.free(token);

        while (true) {
            const encoded_prefix = try percentEncode(allocator, prefix);
            defer allocator.free(encoded_prefix);
            const query = if (continuation_token) |token| blk: {
                const encoded_token = try percentEncode(allocator, token);
                defer allocator.free(encoded_token);
                break :blk try std.fmt.allocPrint(
                    allocator,
                    "list-type=2&prefix={s}&continuation-token={s}",
                    .{ encoded_prefix, encoded_token },
                );
            } else try std.fmt.allocPrint(allocator, "list-type=2&prefix={s}", .{encoded_prefix});
            defer allocator.free(query);

            const bucket_url = try self.bucketUrl(allocator);
            defer allocator.free(bucket_url);
            const url = try std.fmt.allocPrint(allocator, "{s}?{s}", .{ bucket_url, query });
            defer allocator.free(url);

            const sigv4 = try std.fmt.allocPrint(allocator, "aws:amz:{s}:s3", .{self.region});
            defer allocator.free(sigv4);
            const user = try std.fmt.allocPrint(allocator, "{s}:{s}", .{ self.access_key_id, self.secret_access_key });
            defer allocator.free(user);

            const argv = [_][]const u8{
                "curl",
                "-fsS",
                "--aws-sigv4",
                sigv4,
                "--user",
                user,
                "-X",
                "GET",
                url,
            };
            const result = try self.runCurl(allocator, &argv, null);
            defer allocator.free(result.stderr);
            defer allocator.free(result.stdout);
            if (!result.success) {
                return error.StorageListFailed;
            }

            var matches = std.mem.tokenizeSequence(u8, result.stdout, "<Key>");
            _ = matches.next();
            while (matches.next()) |tail| {
                const end = std.mem.indexOf(u8, tail, "</Key>") orelse continue;
                try keys.append(allocator, try allocator.dupe(u8, tail[0..end]));
            }

            const truncated = std.mem.indexOf(u8, result.stdout, "<IsTruncated>true</IsTruncated>") != null;
            const token_start = std.mem.indexOf(u8, result.stdout, "<NextContinuationToken>");
            const token_end = std.mem.indexOf(u8, result.stdout, "</NextContinuationToken>");
            if (!truncated or token_start == null or token_end == null or token_end.? <= token_start.?) {
                break;
            }

            if (continuation_token) |token| allocator.free(token);
            const raw = result.stdout[token_start.? + "<NextContinuationToken>".len .. token_end.?];
            continuation_token = try allocator.dupe(u8, raw);
        }

        return keys.toOwnedSlice(allocator);
    }

    fn repoRoot(self: *MinioStorage, allocator: std.mem.Allocator) ![]u8 {
        return std.fmt.allocPrint(allocator, "{s}/{s}", .{ self.prefix_root, self.repo_id });
    }

    fn repoObjectKey(self: *MinioStorage, allocator: std.mem.Allocator, hash: []const u8) ![]u8 {
        const root = try self.repoRoot(allocator);
        defer allocator.free(root);
        return std.fmt.allocPrint(allocator, "{s}/objects/{s}/{s}", .{ root, hash[0..2], hash[2..] });
    }

    fn repoRefKey(self: *MinioStorage, allocator: std.mem.Allocator, name: []const u8) ![]u8 {
        const root = try self.repoRoot(allocator);
        defer allocator.free(root);
        return std.fmt.allocPrint(allocator, "{s}/{s}", .{ root, name });
    }

    fn repoRefPrefix(self: *MinioStorage, allocator: std.mem.Allocator) ![]u8 {
        const root = try self.repoRoot(allocator);
        defer allocator.free(root);
        return std.fmt.allocPrint(allocator, "{s}/refs/", .{root});
    }

    fn bucketUrl(self: *MinioStorage, allocator: std.mem.Allocator) ![]u8 {
        const endpoint = std.mem.trim(u8, self.endpoint, "/");
        return std.fmt.allocPrint(allocator, "{s}/{s}", .{ endpoint, self.bucket });
    }

    fn objectUrl(self: *MinioStorage, allocator: std.mem.Allocator, key: []const u8) ![]u8 {
        const bucket_url = try self.bucketUrl(allocator);
        defer allocator.free(bucket_url);
        const encoded = try encodeKey(allocator, key);
        defer allocator.free(encoded);
        return std.fmt.allocPrint(allocator, "{s}/{s}", .{ bucket_url, encoded });
    }
};

fn encodeKey(allocator: std.mem.Allocator, key: []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(allocator);
    for (key) |c| {
        switch (c) {
            'A'...'Z', 'a'...'z', '0'...'9', '-', '_', '.', '~', '/' => try out.append(allocator, c),
            else => {
                const escaped = try std.fmt.allocPrint(allocator, "%{X:0>2}", .{c});
                defer allocator.free(escaped);
                try out.appendSlice(allocator, escaped);
            },
        }
    }
    return out.toOwnedSlice(allocator);
}

fn percentEncode(allocator: std.mem.Allocator, input: []const u8) ![]u8 {
    return encodeKey(allocator, input);
}

fn looksMissing(stderr: []const u8) bool {
    return std.mem.indexOf(u8, stderr, "404") != null or std.mem.indexOf(u8, stderr, "NoSuchKey") != null;
}

fn isSuccess(term: std.process.Child.Term) bool {
    return switch (term) {
        .exited => |code| code == 0,
        else => false,
    };
}

fn dupEnvOwned(allocator: std.mem.Allocator, name: []const u8) ![]u8 {
    const key = try allocator.dupeZ(u8, name);
    defer allocator.free(key);
    const value = std.c.getenv(key.ptr) orelse return error.EnvironmentVariableNotFound;
    return allocator.dupe(u8, std.mem.span(value));
}

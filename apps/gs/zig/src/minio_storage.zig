const std = @import("std");
const protocol = @import("protocol.zig");
const hmac = std.crypto.auth.hmac.sha2;
const sha256 = std.crypto.hash.sha2.Sha256;

pub const MinioStorage = struct {
    allocator: std.mem.Allocator,
    io: std.Io,
    client: std.http.Client,
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
            .client = .{
                .allocator = allocator,
                .io = io,
            },
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
        self.client.deinit();
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
        body: []u8,
        status: std.http.Status,
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

    fn runCurl(
        self: *MinioStorage,
        allocator: std.mem.Allocator,
        method: std.http.Method,
        url: []const u8,
        query: ?[]const u8,
        payload: ?[]const u8,
        content_type: ?[]const u8,
    ) !CurlResult {
        const payload_bytes = payload orelse "";
        const payload_hash = sha256Hex(payload_bytes);

        const uri = try std.Uri.parse(url);
        var host_buf: [std.Io.net.HostName.max_len]u8 = undefined;
        const host = try uri.getHost(&host_buf);
        const host_header = try buildHostHeader(allocator, host.bytes, uri.port);
        defer allocator.free(host_header);

        const now = std.Io.Clock.real.now(self.io);
        const amz_date = try formatAmzDate(allocator, @intCast(@divFloor(now.nanoseconds, std.time.ns_per_s)));
        defer allocator.free(amz_date);
        const date_stamp = amz_date[0..8];

        const canonical_uri = uri.path.percent_encoded;
        const canonical_query = if (query) |q|
            q
        else if (uri.query) |q|
            q.percent_encoded
        else
            "";
        const authorization = try buildAuthorizationHeader(
            allocator,
            self,
            method,
            host_header,
            canonical_uri,
            canonical_query,
            amz_date,
            date_stamp,
            payload_hash[0..],
            content_type,
        );
        defer allocator.free(authorization);

        var body_writer: std.Io.Writer.Allocating = .init(allocator);
        defer body_writer.deinit();

        var extra_headers = [_]std.http.Header{
            .{ .name = "x-amz-content-sha256", .value = payload_hash[0..] },
            .{ .name = "x-amz-date", .value = amz_date },
        };

        const result = try self.client.fetch(.{
            .location = .{ .url = url },
            .method = method,
            .payload = if (payload != null) payload_bytes else null,
            .response_writer = &body_writer.writer,
            .headers = .{
                .host = .{ .override = host_header },
                .authorization = .{ .override = authorization },
                .content_type = if (content_type) |v| .{ .override = v } else .omit,
            },
            .extra_headers = &extra_headers,
            .keep_alive = true,
        });

        return .{
            .body = try body_writer.toOwnedSlice(),
            .status = result.status,
        };
    }

    fn getKeyBytes(self: *MinioStorage, allocator: std.mem.Allocator, key: []const u8) !?[]u8 {
        const url = try self.objectUrl(allocator, key);
        defer allocator.free(url);

        const result = try self.runCurl(allocator, .GET, url, null, null, null);
        errdefer allocator.free(result.body);
        if (result.status.class() != .success) {
            std.debug.print("[minio] getKeyBytes key={s} status={d} body={s}\n", .{ key, @intFromEnum(result.status), result.body });
            if (looksMissing(result.status, result.body)) {
                allocator.free(result.body);
                return null;
            }
            return error.StorageReadFailed;
        }
        return result.body;
    }

    fn putKeyBytes(self: *MinioStorage, key: []const u8, data: []const u8, content_type: []const u8) !void {
        const allocator = self.allocator;
        const url = try self.objectUrl(allocator, key);
        defer allocator.free(url);
        const result = try self.runCurl(allocator, .PUT, url, null, data, content_type);
        defer allocator.free(result.body);
        if (result.status.class() != .success) {
            std.debug.print("[minio] putKeyBytes key={s} status={d} body={s}\n", .{ key, @intFromEnum(result.status), result.body });
            return error.StorageWriteFailed;
        }
    }

    fn deleteKey(self: *MinioStorage, key: []const u8) !void {
        const allocator = self.allocator;
        const url = try self.objectUrl(allocator, key);
        defer allocator.free(url);
        const result = try self.runCurl(allocator, .DELETE, url, null, null, null);
        defer allocator.free(result.body);
        if (result.status.class() != .success and !looksMissing(result.status, result.body)) {
            std.debug.print("[minio] deleteKey key={s} status={d} body={s}\n", .{ key, @intFromEnum(result.status), result.body });
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
            const result = try self.runCurl(allocator, .GET, url, query, null, null);
            defer allocator.free(result.body);
            if (result.status.class() != .success) {
                std.debug.print("[minio] listKeys prefix={s} status={d} body={s}\n", .{
                    prefix,
                    @intFromEnum(result.status),
                    result.body,
                });
                return error.StorageListFailed;
            }

            var matches = std.mem.tokenizeSequence(u8, result.body, "<Key>");
            _ = matches.next();
            while (matches.next()) |tail| {
                const end = std.mem.indexOf(u8, tail, "</Key>") orelse continue;
                try keys.append(allocator, try allocator.dupe(u8, tail[0..end]));
            }

            const truncated = std.mem.indexOf(u8, result.body, "<IsTruncated>true</IsTruncated>") != null;
            const token_start = std.mem.indexOf(u8, result.body, "<NextContinuationToken>");
            const token_end = std.mem.indexOf(u8, result.body, "</NextContinuationToken>");
            if (!truncated or token_start == null or token_end == null or token_end.? <= token_start.?) {
                break;
            }

            if (continuation_token) |token| allocator.free(token);
            const raw = result.body[token_start.? + "<NextContinuationToken>".len .. token_end.?];
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
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(allocator);
    for (input) |c| {
        switch (c) {
            'A'...'Z', 'a'...'z', '0'...'9', '-', '_', '.', '~' => try out.append(allocator, c),
            else => {
                const escaped = try std.fmt.allocPrint(allocator, "%{X:0>2}", .{c});
                defer allocator.free(escaped);
                try out.appendSlice(allocator, escaped);
            },
        }
    }
    return out.toOwnedSlice(allocator);
}

fn looksMissing(status: std.http.Status, body: []const u8) bool {
    return status == .not_found or std.mem.indexOf(u8, body, "NoSuchKey") != null;
}

fn buildHostHeader(allocator: std.mem.Allocator, host: []const u8, maybe_port: ?u16) ![]u8 {
    if (maybe_port) |port| {
        return std.fmt.allocPrint(allocator, "{s}:{d}", .{ host, port });
    }
    return allocator.dupe(u8, host);
}

fn formatAmzDate(allocator: std.mem.Allocator, unix_seconds: u64) ![]u8 {
    const epoch_seconds = std.time.epoch.EpochSeconds{ .secs = unix_seconds };
    const year_day = epoch_seconds.getEpochDay().calculateYearDay();
    const month_day = year_day.calculateMonthDay();
    const day_seconds = epoch_seconds.getDaySeconds();
    return std.fmt.allocPrint(
        allocator,
        "{d:0>4}{d:0>2}{d:0>2}T{d:0>2}{d:0>2}{d:0>2}Z",
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

fn sha256Hex(data: []const u8) [64]u8 {
    var digest: [sha256.digest_length]u8 = undefined;
    sha256.hash(data, &digest, .{});
    return std.fmt.bytesToHex(digest, .lower);
}

fn dupEnvOwned(allocator: std.mem.Allocator, name: []const u8) ![]u8 {
    const key = try allocator.dupeZ(u8, name);
    defer allocator.free(key);
    const value = std.c.getenv(key.ptr) orelse return error.EnvironmentVariableNotFound;
    return allocator.dupe(u8, std.mem.span(value));
}

fn hmacSha256(key: []const u8, data: []const u8) [hmac.HmacSha256.mac_length]u8 {
    var out: [hmac.HmacSha256.mac_length]u8 = undefined;
    hmac.HmacSha256.create(out[0..], data, key);
    return out;
}

fn lowercaseHeaderName(name: []const u8) []const u8 {
    return name;
}

fn trimHeaderValue(value: []const u8) []const u8 {
    return std.mem.trim(u8, value, " \t\r\n");
}

fn canonicalQueryString(query: []const u8) []const u8 {
    return query;
}

fn methodName(method: std.http.Method) []const u8 {
    return @tagName(method);
}

fn buildCanonicalRequest(
    allocator: std.mem.Allocator,
    method: std.http.Method,
    canonical_uri: []const u8,
    query: []const u8,
    canonical_headers: []const u8,
    signed_headers: []const u8,
    payload_hash: []const u8,
) ![]u8 {
    return std.fmt.allocPrint(
        allocator,
        "{s}\n{s}\n{s}\n{s}\n{s}\n{s}",
        .{
            methodName(method),
            canonical_uri,
            canonicalQueryString(query),
            canonical_headers,
            signed_headers,
            payload_hash,
        },
    );
}

fn buildStringToSign(
    allocator: std.mem.Allocator,
    amz_date: []const u8,
    credential_scope: []const u8,
    canonical_request: []const u8,
) ![]u8 {
    const request_hash = sha256Hex(canonical_request);
    return std.fmt.allocPrint(
        allocator,
        "AWS4-HMAC-SHA256\n{s}\n{s}\n{s}",
        .{ amz_date, credential_scope, request_hash },
    );
}

fn signingKey(
    secret_access_key: []const u8,
    date_stamp: []const u8,
    region: []const u8,
    service: []const u8,
) [hmac.HmacSha256.mac_length]u8 {
    const k_secret = std.fmt.comptimePrint("AWS4", .{});
    var key_buf: [256]u8 = undefined;
    @memcpy(key_buf[0..k_secret.len], k_secret);
    @memcpy(key_buf[k_secret.len .. k_secret.len + secret_access_key.len], secret_access_key);
    const secret_key = key_buf[0 .. k_secret.len + secret_access_key.len];

    const k_date = hmacSha256(secret_key, date_stamp);
    const k_region = hmacSha256(k_date[0..], region);
    const k_service = hmacSha256(k_region[0..], service);
    return hmacSha256(k_service[0..], "aws4_request");
}

fn buildCanonicalHeaders(
    allocator: std.mem.Allocator,
    host_header: []const u8,
    amz_date: []const u8,
    payload_hash: []const u8,
    content_type: ?[]const u8,
) !struct { headers: []u8, signed_headers: []const u8 } {
    if (content_type) |value| {
        return .{
            .headers = try std.fmt.allocPrint(
                allocator,
                "content-type:{s}\nhost:{s}\nx-amz-content-sha256:{s}\nx-amz-date:{s}\n",
                .{ trimHeaderValue(value), trimHeaderValue(host_header), payload_hash, amz_date },
            ),
            .signed_headers = "content-type;host;x-amz-content-sha256;x-amz-date",
        };
    }

    return .{
        .headers = try std.fmt.allocPrint(
            allocator,
            "host:{s}\nx-amz-content-sha256:{s}\nx-amz-date:{s}\n",
            .{ trimHeaderValue(host_header), payload_hash, amz_date },
        ),
        .signed_headers = "host;x-amz-content-sha256;x-amz-date",
    };
}

fn buildAuthorizationHeader(
    allocator: std.mem.Allocator,
    self: *MinioStorage,
    method: std.http.Method,
    host_header: []const u8,
    canonical_uri: []const u8,
    query: []const u8,
    amz_date: []const u8,
    date_stamp: []const u8,
    payload_hash: []const u8,
    content_type: ?[]const u8,
) ![]u8 {
    const service = "s3";
    const canonical = try buildCanonicalHeaders(allocator, host_header, amz_date, payload_hash, content_type);
    defer allocator.free(canonical.headers);

    const canonical_request = try buildCanonicalRequest(
        allocator,
        method,
        canonical_uri,
        query,
        canonical.headers,
        canonical.signed_headers,
        payload_hash,
    );
    defer allocator.free(canonical_request);

    const credential_scope = try std.fmt.allocPrint(allocator, "{s}/{s}/{s}/aws4_request", .{
        date_stamp,
        self.region,
        service,
    });
    defer allocator.free(credential_scope);

    const string_to_sign = try buildStringToSign(allocator, amz_date, credential_scope, canonical_request);
    defer allocator.free(string_to_sign);

    const signature = hmacSha256(signingKey(self.secret_access_key, date_stamp, self.region, service)[0..], string_to_sign);
    const signature_hex = std.fmt.bytesToHex(signature, .lower);

    return std.fmt.allocPrint(
        allocator,
        "AWS4-HMAC-SHA256 Credential={s}/{s}, SignedHeaders={s}, Signature={s}",
        .{ self.access_key_id, credential_scope, canonical.signed_headers, signature_hex },
    );
}

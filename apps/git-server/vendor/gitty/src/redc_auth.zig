const std = @import("std");

const sha2 = std.crypto.hash.sha2;
const hmac = std.crypto.auth.hmac.sha2;
const base64 = std.base64;

pub const RepoAccess = enum { read, write };

pub const RepoAccessTokenClaims = struct {
    v: u8 = 1,
    sub: []const u8,
    repoId: []const u8,
    access: RepoAccess,
    exp: i64,
};

pub const AuthConfig = struct {
    admin_username: ?[]const u8 = null,
    admin_password: ?[]const u8 = null,
    token_secret: ?[]const u8 = null,
};

pub const Credentials = struct {
    username: []u8,
    password: []u8,
};

pub const AuthorizationDecision = union(enum) {
    ok,
    deny: []const u8,
};

pub fn accessAllows(granted: RepoAccess, required: RepoAccess) bool {
    return granted == .write or granted == required;
}

pub fn issueRepoCredentials(
    allocator: std.mem.Allocator,
    secret: []const u8,
    actor_id: []const u8,
    repo_id: []const u8,
    access: RepoAccess,
    ttl_seconds: i64,
) !Credentials {
    return .{
        .username = try allocator.dupe(u8, actor_id),
        .password = try signAccessToken(
            allocator,
            secret,
            actor_id,
            repo_id,
            access,
            nowSeconds() + ttl_seconds,
        ),
    };
}

pub fn signAccessToken(
    allocator: std.mem.Allocator,
    secret: []const u8,
    actor_id: []const u8,
    repo_id: []const u8,
    access: RepoAccess,
    exp_seconds: i64,
) ![]u8 {
    const payload = .{
        .v = @as(u8, 1),
        .sub = actor_id,
        .repoId = repo_id,
        .access = access,
        .exp = exp_seconds,
    };

    const encoded_payload = try std.json.stringifyAlloc(allocator, payload, .{});
    defer allocator.free(encoded_payload);

    var signature: [hmac.HmacSha256.mac_length]u8 = undefined;
    hmac.HmacSha256.create(signature[0..], encoded_payload, secret);

    const encoder = base64.url_safe_no_pad.Encoder;
    const encoded_signature_len = encoder.calcSize(signature.len);
    const encoded_signature = try allocator.alloc(u8, encoded_signature_len);
    defer allocator.free(encoded_signature);
    const signature_bytes = encoder.encode(encoded_signature, signature[0..]);

    const token = try std.fmt.allocPrint(
        allocator,
        "{s}.{s}",
        .{ encoded_payload, signature_bytes },
    );
    return token;
}

pub fn verifyAccessTokenClaims(
    allocator: std.mem.Allocator,
    token: []const u8,
    secret: []const u8,
) !?RepoAccessTokenClaims {
    const dot = std.mem.indexOfScalar(u8, token, '.') orelse return null;
    const encoded_payload = token[0..dot];
    const encoded_signature = token[dot + 1 ..];

    const payload = decodeBase64(allocator, base64.url_safe_no_pad.Decoder, encoded_payload) catch return null;
    defer allocator.free(payload);

    const expected = computeSignature(encoded_payload, secret);

    var actual: [hmac.HmacSha256.mac_length]u8 = undefined;
    const actual_len = base64.url_safe_no_pad.Decoder.calcSizeForSlice(encoded_signature) catch return null;
    if (actual_len != actual.len) return null;
    base64.url_safe_no_pad.Decoder.decode(actual[0..], encoded_signature) catch return null;

    if (!timingSafeEqual(expected[0..], actual[0..])) {
        return null;
    }

    const parsed = std.json.parseFromSlice(RepoAccessTokenClaims, allocator, payload, .{}) catch return null;
    defer parsed.deinit();

    if (parsed.value.v != 1) return null;
    if (nowSeconds() >= parsed.value.exp) return null;

    const sub = try allocator.dupe(u8, parsed.value.sub);
    errdefer allocator.free(sub);
    const repo_id = try allocator.dupe(u8, parsed.value.repoId);
    errdefer allocator.free(repo_id);

    return .{
        .v = parsed.value.v,
        .sub = sub,
        .repoId = repo_id,
        .access = parsed.value.access,
        .exp = parsed.value.exp,
    };
}

pub fn authorizeBasicAuth(
    allocator: std.mem.Allocator,
    authorization_header: ?[]const u8,
    config: AuthConfig,
    repo_id: []const u8,
    required_access: RepoAccess,
) !AuthorizationDecision {
    if (config.admin_username == null and config.token_secret == null) {
        return .{ .deny = "Auth provider is not configured" };
    }

    const header = authorization_header orelse {
        return .{ .deny = "Missing basic auth credentials" };
    };
    if (!std.mem.startsWith(u8, header, "Basic ")) {
        return .{ .deny = "Missing basic auth credentials" };
    }

    const decoded = decodeBase64(allocator, base64.standard.Decoder, header["Basic ".len..]) catch
        return .{ .deny = "Malformed basic auth credentials" };
    defer allocator.free(decoded);

    const separator = std.mem.indexOfScalar(u8, decoded, ':') orelse {
        return .{ .deny = "Malformed basic auth credentials" };
    };
    const username = decoded[0..separator];
    const password = decoded[separator + 1 ..];

    if (config.admin_username != null and config.admin_password != null and
        std.mem.eql(u8, username, config.admin_username.?) and
        std.mem.eql(u8, password, config.admin_password.?))
    {
        return .ok;
    }

    const secret = config.token_secret orelse return .{ .deny = "Invalid access token" };
    const token = try verifyAccessTokenClaims(allocator, password, secret) orelse {
        return .{ .deny = "Invalid access token" };
    };
    defer {
        allocator.free(token.sub);
        allocator.free(token.repoId);
    }

    if (!std.mem.eql(u8, token.sub, username)) {
        return .{ .deny = "Credential subject mismatch" };
    }
    if (!std.mem.eql(u8, token.repoId, repo_id)) {
        return .{ .deny = "Credentials do not allow access to this repo" };
    }
    if (!accessAllows(token.access, required_access)) {
        return .{ .deny = "Credentials do not allow requested access" };
    }

    return .ok;
}

fn computeSignature(encoded_payload: []const u8, secret: []const u8) [hmac.HmacSha256.mac_length]u8 {
    var signature: [hmac.HmacSha256.mac_length]u8 = undefined;
    hmac.HmacSha256.create(signature[0..], encoded_payload, secret);
    return signature;
}

fn decodeBase64(
    allocator: std.mem.Allocator,
    comptime decoder: anytype,
    input: []const u8,
) ![]u8 {
    const len = try decoder.calcSizeForSlice(input);
    const output = try allocator.alloc(u8, len);
    errdefer allocator.free(output);
    try decoder.decode(output, input);
    return output;
}

fn nowSeconds() i64 {
    var ts: std.c.timespec = undefined;
    if (std.c.clock_gettime(std.c.CLOCK.REALTIME, &ts) != 0) return 0;
    return @as(i64, @intCast(ts.sec));
}

fn timingSafeEqual(a: []const u8, b: []const u8) bool {
    if (a.len != b.len) return false;
    var diff: u8 = 0;
    for (a, b) |x, y| {
        diff |= x ^ y;
    }
    return diff == 0;
}

test "access allows write to satisfy read" {
    try std.testing.expect(accessAllows(.write, .read));
    try std.testing.expect(accessAllows(.write, .write));
    try std.testing.expect(accessAllows(.read, .read));
    try std.testing.expect(!accessAllows(.read, .write));
}

test "sign and verify repo token" {
    const allocator = std.testing.allocator;
    const secret = "secret";
    const token = try signAccessToken(allocator, secret, "alice", "alice/repo", .write, 1_700_000_000 + 60);
    defer allocator.free(token);

    const claims = try verifyAccessTokenClaims(allocator, token, secret) orelse return error.TestUnexpectedResult;
    defer {
        allocator.free(claims.sub);
        allocator.free(claims.repoId);
    }

    try std.testing.expectEqualStrings("alice", claims.sub);
    try std.testing.expectEqualStrings("alice/repo", claims.repoId);
    try std.testing.expectEqual(RepoAccess.write, claims.access);
    try std.testing.expectEqual(@as(u8, 1), claims.v);
}

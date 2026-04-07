/// Multi-threaded git smart HTTP server using libgitty.
/// Now also serves the native control-plane routes directly from Zig.
const std = @import("std");
const auth_mod = @import("redc_auth.zig");
const control_plane_mod = @import("control_plane.zig");
const protocol = @import("protocol.zig");
const storage_mod = @import("storage.zig");
const minio_storage_mod = @import("minio_storage.zig");

const Io = std.Io;
const Dir = Io.Dir;
const net = Io.net;
const p = std.debug.print;

pub fn main(init: std.process.Init) !void {
    const alloc = init.gpa;
    const io = init.io;
    const auth_config = loadAuthConfig();
    var file_cache = control_plane_mod.FileContentCache.init(alloc);
    defer file_cache.deinit();

    var args = std.process.Args.Iterator.init(init.minimal.args);
    _ = args.next();
    const port_str: []const u8 = if (args.next()) |a| a else "9418";
    const data_dir: []const u8 = if (args.next()) |a| a else "/tmp/libgitty-data";
    const port = std.fmt.parseInt(u16, port_str, 10) catch 9418;
    const use_minio = std.c.getenv("GIT_SERVER_S3_ENDPOINT") != null;

    Dir.cwd().createDirPath(io, data_dir) catch {};

    var store = try storage_mod.DiskStorage.init(alloc, io, data_dir);
    defer store.deinit();
    var adapter = store.adapter();

    p("libgitty server on :{d} ({s}) mode={s}\n", .{ port, data_dir, if (use_minio) "minio" else "disk" });

    var server = try net.IpAddress.listen(.{ .ip4 = .{ .bytes = .{ 0, 0, 0, 0 }, .port = port } }, io, .{ .reuse_address = true });
    defer server.deinit(io);

    while (true) {
        var conn = server.accept(io) catch continue;
        handleConnection(alloc, io, &conn, if (use_minio) null else &adapter, use_minio, auth_config, &file_cache);
        conn.close(io);
    }
}

fn handleConnection(
    alloc: std.mem.Allocator,
    io: Io,
    conn: *net.Stream,
    disk_adapter: ?*protocol.StorageAdapter,
    use_minio: bool,
    auth_config: auth_mod.AuthConfig,
    file_cache: *control_plane_mod.FileContentCache,
) void {
    var read_buf: [65536]u8 = undefined;
    var rdr = conn.reader(io, &read_buf);
    _ = handleRequest(alloc, io, conn, &rdr, disk_adapter, use_minio, auth_config, file_cache) catch {};
}

fn handleRequest(
    alloc: std.mem.Allocator,
    io: Io,
    conn: *net.Stream,
    rdr: *net.Stream.Reader,
    disk_adapter: ?*protocol.StorageAdapter,
    use_minio: bool,
    auth_config: auth_mod.AuthConfig,
    file_cache: *control_plane_mod.FileContentCache,
) !bool {
    var hdr: [8192]u8 = undefined;
    var hdr_len: usize = 0;

    while (hdr_len < hdr.len) {
        var one: [1]u8 = undefined;
        var bufs = [_][]u8{&one};
        const n = rdr.interface.readVec(&bufs) catch return false;
        if (n == 0) return false;
        hdr[hdr_len] = one[0];
        hdr_len += 1;
        if (hdr_len >= 4 and
            hdr[hdr_len - 4] == '\r' and hdr[hdr_len - 3] == '\n' and
            hdr[hdr_len - 2] == '\r' and hdr[hdr_len - 1] == '\n')
            break;
    }
    if (hdr_len == 0) return false;

    const first_end = std.mem.indexOf(u8, hdr[0..hdr_len], "\r\n") orelse return false;
    const req_line = hdr[0..first_end];
    var parts = std.mem.splitScalar(u8, req_line, ' ');
    const method = parts.next() orelse return false;
    const raw_path = parts.next() orelse return false;

    var content_length: ?usize = null;
    var chunked = false;
    const keep_alive = false;
    var authorization: ?[]const u8 = null;
    var lines = std.mem.splitSequence(u8, hdr[0..hdr_len], "\r\n");
    while (lines.next()) |line| {
        if (std.mem.startsWith(u8, line, "Content-Length: ") or
            std.mem.startsWith(u8, line, "content-length: "))
        {
            content_length = std.fmt.parseInt(usize, line[16..], 10) catch 0;
        }
        if (std.mem.startsWith(u8, line, "Transfer-Encoding: chunked") or
            std.mem.startsWith(u8, line, "transfer-encoding: chunked"))
        {
            chunked = true;
        }
        if (std.mem.startsWith(u8, line, "Authorization: ") or
            std.mem.startsWith(u8, line, "authorization: "))
        {
            authorization = std.mem.trimStart(u8, line[15..], " \t");
        }
    }

    var body: []u8 = &.{};
    var body_allocated = false;
    if (chunked) {
        body = try readChunkedBody(alloc, rdr);
        body_allocated = body.len > 0;
    } else if (content_length) |cl| {
        if (cl > 0) {
            body = try alloc.alloc(u8, cl);
            body_allocated = true;
            var got: usize = 0;
            while (got < cl) {
                var dest = [_][]u8{body[got..cl]};
                const n = rdr.interface.readVec(&dest) catch break;
                if (n == 0) break;
                got += n;
            }
        }
    }
    defer if (body_allocated) alloc.free(body);

    const path = if (std.mem.indexOf(u8, raw_path, "?")) |qi| raw_path[0..qi] else raw_path;
    p("{s} ({d}B)\n", .{ req_line, body.len });

    if (parseControlPlaneRoute(path)) |route| {
        const repo_id = std.fmt.allocPrint(alloc, "{s}/{s}", .{ route.owner, route.repo }) catch {
            return sendPlainError(io, conn, "500 Internal Server Error", "internal control-plane error\n", keep_alive);
        };
        defer alloc.free(repo_id);

        const auth_error = authorizeRequest(alloc, auth_config, authorization, repo_id, .read) catch {
            return sendPlainError(io, conn, "500 Internal Server Error", "internal authentication error\n", keep_alive);
        };
        if (auth_error) |reason| {
            return sendUnauthorized(io, conn, reason, keep_alive);
        }

        var repo_storage = try openRepoStorage(alloc, io, repo_id, use_minio, disk_adapter);
        defer repo_storage.deinit();

        return handleControlPlaneRequest(
            alloc,
            io,
            conn,
            route,
            repo_id,
            raw_path,
            repo_storage.adapter,
            keep_alive,
            file_cache,
        );
    }

    const maybe_repo_id = parseRepoId(alloc, path);
    defer if (maybe_repo_id) |repo_id| alloc.free(repo_id);

    if (std.mem.endsWith(u8, path, "/info/refs")) {
        const repo_id = maybe_repo_id orelse {
            return sendPlainError(io, conn, "404 Not Found", "Missing repo\n", keep_alive);
        };
        const required_access = getRequiredAccess(method, path, raw_path);
        const auth_error = authorizeRequest(alloc, auth_config, authorization, repo_id, required_access) catch {
            return sendPlainError(io, conn, "500 Internal Server Error", "internal authentication error\n", keep_alive);
        };
        if (auth_error) |reason| {
            return sendUnauthorized(io, conn, reason, keep_alive);
        }

        var repo_storage = try openRepoStorage(alloc, io, repo_id, use_minio, disk_adapter);
        defer repo_storage.deinit();
        const is_rp = std.mem.indexOf(u8, raw_path, "service=git-receive-pack") != null;
        const is_up = std.mem.indexOf(u8, raw_path, "service=git-upload-pack") != null;
        const service: []const u8 = if (is_rp) "git-receive-pack" else if (is_up) "git-upload-pack" else {
            return sendPlainError(io, conn, "403 Forbidden", "Unsupported\n", keep_alive);
        };
        const resp = try protocol.advertiseRefs(alloc, repo_storage.adapter, service);
        defer alloc.free(resp);
        var ct: [80]u8 = undefined;
        const content_type = std.fmt.bufPrint(&ct, "application/x-{s}-advertisement", .{service}) catch "application/octet-stream";
        _ = sendResponse(io, conn, "200 OK", content_type, resp, keep_alive);
    } else if (std.mem.endsWith(u8, path, "/git-receive-pack") and std.mem.eql(u8, method, "POST")) {
        const repo_id = maybe_repo_id orelse {
            return sendPlainError(io, conn, "404 Not Found", "Missing repo\n", keep_alive);
        };
        const auth_error = authorizeRequest(alloc, auth_config, authorization, repo_id, .write) catch {
            return sendPlainError(io, conn, "500 Internal Server Error", "internal authentication error\n", keep_alive);
        };
        if (auth_error) |reason| {
            return sendUnauthorized(io, conn, reason, keep_alive);
        }

        var repo_storage = try openRepoStorage(alloc, io, repo_id, use_minio, disk_adapter);
        defer repo_storage.deinit();
        const resp = try protocol.handleReceivePack(alloc, repo_storage.adapter, body);
        defer alloc.free(resp);
        _ = sendResponse(io, conn, "200 OK", "application/x-git-receive-pack-result", resp, keep_alive);
    } else if (std.mem.endsWith(u8, path, "/git-upload-pack") and std.mem.eql(u8, method, "POST")) {
        const repo_id = maybe_repo_id orelse {
            return sendPlainError(io, conn, "404 Not Found", "Missing repo\n", keep_alive);
        };
        const auth_error = authorizeRequest(alloc, auth_config, authorization, repo_id, .read) catch {
            return sendPlainError(io, conn, "500 Internal Server Error", "internal authentication error\n", keep_alive);
        };
        if (auth_error) |reason| {
            return sendUnauthorized(io, conn, reason, keep_alive);
        }

        var repo_storage = try openRepoStorage(alloc, io, repo_id, use_minio, disk_adapter);
        defer repo_storage.deinit();
        const resp = try protocol.handleUploadPack(alloc, repo_storage.adapter, body);
        defer alloc.free(resp);
        _ = sendResponse(io, conn, "200 OK", "application/x-git-upload-pack-result", resp, keep_alive);
    } else {
        const body_json = try std.fmt.allocPrint(
            alloc,
            "{{\"name\":\"libgitty\",\"version\":\"0.1.0\",\"mode\":\"{s}\",\"auth\":{{\"enabled\":true}}}}\n",
            .{if (use_minio) "minio" else "disk"},
        );
        defer alloc.free(body_json);
        _ = sendResponse(io, conn, "200 OK", "application/json", body_json, keep_alive);
    }

    return keep_alive;
}

fn handleControlPlaneRequest(
    alloc: std.mem.Allocator,
    io: Io,
    conn: *net.Stream,
    route: ControlPlaneRoute,
    repo_id: []const u8,
    raw_path: []const u8,
    adapter: protocol.StorageAdapter,
    keep_alive: bool,
    file_cache: *control_plane_mod.FileContentCache,
) !bool {
    var cp = control_plane_mod.ControlPlane.init(alloc, adapter, repo_id, file_cache);
    const result = switch (route.resource) {
        .repo => cp.getRepoJson(),
        .branches => cp.listBranchesJson(),
        .commits => blk: {
            const ref = queryParam(alloc, raw_path, "ref") catch null;
            defer if (ref) |value| alloc.free(value);
            const limit_str = queryParam(alloc, raw_path, "limit") catch null;
            defer if (limit_str) |value| alloc.free(value);
            const ref_value = ref orelse "main";
            const limit = if (limit_str) |value| std.fmt.parseInt(usize, value, 10) catch 20 else 20;
            break :blk cp.listCommitsJson(ref_value, limit);
        },
        .file => blk: {
            const path = queryParam(alloc, raw_path, "path") catch null;
            defer if (path) |value| alloc.free(value);
            const ref = queryParam(alloc, raw_path, "ref") catch null;
            defer if (ref) |value| alloc.free(value);
            const path_value = path orelse return sendJsonError(alloc, io, conn, "Missing required query param: path", keep_alive);
            const ref_value = ref orelse "main";
            p("[control-plane] file path={s} ref={s}\n", .{ path_value, ref_value });
            break :blk cp.getFileContentJson(path_value, ref_value);
        },
        .compare => blk: {
            const base = queryParam(alloc, raw_path, "base") catch null;
            defer if (base) |value| alloc.free(value);
            const head = queryParam(alloc, raw_path, "head") catch null;
            defer if (head) |value| alloc.free(value);
            const patch = queryParam(alloc, raw_path, "patch") catch null;
            defer if (patch) |value| alloc.free(value);
            const base_value = base orelse return sendJsonError(alloc, io, conn, "Missing required query params: base, head", keep_alive);
            const head_value = head orelse return sendJsonError(alloc, io, conn, "Missing required query params: base, head", keep_alive);
            const include_patch = patch != null and std.mem.eql(u8, patch.?, "1");
            break :blk cp.compareJson(base_value, head_value, include_patch);
        },
    } catch |err| {
        const message = errorMessage(err);
        p("[control-plane] error={s}\n", .{message});
        return sendJsonError(alloc, io, conn, message, keep_alive);
    };

    defer alloc.free(result);
    p("[control-plane] response bytes={d}\n", .{result.len});
    _ = sendResponse(io, conn, "200 OK", "application/json", result, keep_alive);
    return keep_alive;
}

fn openRepoStorage(
    alloc: std.mem.Allocator,
    io: Io,
    repo_id: []const u8,
    use_minio: bool,
    disk_adapter: ?*protocol.StorageAdapter,
) !RepoStorage {
    if (use_minio) {
        const minio = try alloc.create(minio_storage_mod.MinioStorage);
        errdefer alloc.destroy(minio);
        minio.* = try minio_storage_mod.MinioStorage.init(alloc, io, repo_id);
        return .{
            .minio = minio,
            .adapter = minio.adapter(),
        };
    }

    return .{
        .minio = null,
        .adapter = disk_adapter.?.*,
    };
}

fn authorizeRequest(
    alloc: std.mem.Allocator,
    auth_config: auth_mod.AuthConfig,
    authorization_header: ?[]const u8,
    repo_id: []const u8,
    required_access: auth_mod.RepoAccess,
) !?[]const u8 {
    const decision = try auth_mod.authorizeBasicAuth(alloc, authorization_header, auth_config, repo_id, required_access);
    return switch (decision) {
        .ok => null,
        .deny => |reason| reason,
    };
}

fn loadAuthConfig() auth_mod.AuthConfig {
    return .{
        .admin_username = requireEnv("GIT_SERVER_ADMIN_USERNAME"),
        .admin_password = requireEnv("GIT_SERVER_ADMIN_PASSWORD"),
        .token_secret = requireEnv("GIT_SERVER_AUTH_TOKEN_SECRET"),
    };
}

fn getRequiredAccess(method: []const u8, path: []const u8, raw_path: []const u8) auth_mod.RepoAccess {
    if (std.mem.eql(u8, method, "POST") and std.mem.endsWith(u8, path, "/git-receive-pack")) {
        return .write;
    }
    if (std.mem.endsWith(u8, path, "/info/refs")) {
        if (queryParamStatic(raw_path, "service")) |service| {
            if (std.mem.eql(u8, service, "git-receive-pack")) return .write;
        }
    }
    return .read;
}

fn queryParamStatic(raw_path: []const u8, key: []const u8) ?[]const u8 {
    return queryParamNoAlloc(raw_path, key);
}

fn queryParam(allocator: std.mem.Allocator, raw_path: []const u8, key: []const u8) !?[]u8 {
    const value = queryParamNoAlloc(raw_path, key) orelse return null;
    return @as(?[]u8, try decodeQueryComponent(allocator, value));
}

fn queryParamNoAlloc(raw_path: []const u8, key: []const u8) ?[]const u8 {
    const qmark = std.mem.indexOfScalar(u8, raw_path, '?') orelse return null;
    var rest = raw_path[qmark + 1 ..];
    while (rest.len > 0) {
        const amp = std.mem.indexOfScalar(u8, rest, '&') orelse rest.len;
        const pair = rest[0..amp];
        const eq = std.mem.indexOfScalar(u8, pair, '=') orelse pair.len;
        const pair_key = pair[0..eq];
        if (std.mem.eql(u8, pair_key, key)) {
            return if (eq < pair.len) pair[eq + 1 ..] else "";
        }
        if (amp == rest.len) break;
        rest = rest[amp + 1 ..];
    }
    return null;
}

fn decodeQueryComponent(allocator: std.mem.Allocator, input: []const u8) ![]u8 {
    const out = try allocator.dupe(u8, input);
    for (out) |*b| {
        if (b.* == '+') b.* = ' ';
    }
    return std.Uri.percentDecodeInPlace(out);
}

fn parseControlPlaneRoute(pathname: []const u8) ?ControlPlaneRoute {
    if (!std.mem.startsWith(u8, pathname, "/api/repos/")) return null;
    var rest = pathname["/api/repos/".len..];
    const owner_end = std.mem.indexOfScalar(u8, rest, '/') orelse return null;
    const owner = rest[0..owner_end];
    rest = rest[owner_end + 1 ..];

    var resource: ControlPlaneResource = .repo;
    var repo = rest;
    if (std.mem.indexOfScalar(u8, rest, '/')) |slash| {
        repo = rest[0..slash];
        const suffix = rest[slash + 1 ..];
        if (std.mem.eql(u8, suffix, "branches")) resource = .branches
        else if (std.mem.eql(u8, suffix, "commits")) resource = .commits
        else if (std.mem.eql(u8, suffix, "file")) resource = .file
        else if (std.mem.eql(u8, suffix, "compare")) resource = .compare
        else return null;
    }

    return .{
        .owner = owner,
        .repo = repo,
        .resource = resource,
    };
}

const ControlPlaneResource = enum { repo, branches, commits, file, compare };

const ControlPlaneRoute = struct {
    owner: []const u8,
    repo: []const u8,
    resource: ControlPlaneResource,
};

const RepoStorage = struct {
    minio: ?*minio_storage_mod.MinioStorage,
    adapter: protocol.StorageAdapter,

    fn deinit(self: *RepoStorage) void {
        if (self.minio) |store| {
            store.deinit();
            store.allocator.destroy(store);
        }
    }
};

fn sendUnauthorized(io: Io, conn: *net.Stream, reason: []const u8, keep_alive: bool) bool {
    return sendResponseWithHeaders(
        io,
        conn,
        "401 Unauthorized",
        "WWW-Authenticate: Basic realm=\"gitty\"\r\n",
        "text/plain",
        reason,
        keep_alive,
    );
}

fn sendPlainError(io: Io, conn: *net.Stream, status: []const u8, body: []const u8, keep_alive: bool) bool {
    return sendResponse(io, conn, status, "text/plain", body, keep_alive);
}

fn sendJsonError(alloc: std.mem.Allocator, io: Io, conn: *net.Stream, message: []const u8, keep_alive: bool) bool {
    const json = buildErrorJson(alloc, message) catch return false;
    defer alloc.free(json);
    return sendResponse(io, conn, "500 Internal Server Error", "application/json", json, keep_alive);
}

fn controlPlaneErrorResponse(alloc: std.mem.Allocator, io: Io, conn: *net.Stream, repo_id: []const u8, path: []const u8, err: anyerror, keep_alive: bool) bool {
    const message = errorMessage(err);
    p("[control-plane] repo={s} path={s} error={s}\n", .{ repo_id, path, message });
    return sendJsonError(alloc, io, conn, message, keep_alive);
}

fn errorMessage(err: anyerror) []const u8 {
    return @errorName(err);
}

fn requireEnv(name: []const u8) []const u8 {
    var buf: [128]u8 = undefined;
    const c_name = std.fmt.bufPrintZ(&buf, "{s}", .{name}) catch @panic("env var name too long");
    const value = std.c.getenv(c_name) orelse std.debug.panic("Missing required env var: {s}", .{name});
    return std.mem.span(value);
}

fn buildErrorJson(alloc: std.mem.Allocator, message: []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(alloc);
    try out.appendSlice(alloc, "{\"error\":\"");
    try appendJsonEscaped(&out, alloc, message);
    try out.appendSlice(alloc, "\"}");
    return out.toOwnedSlice(alloc);
}

fn appendJsonEscaped(out: *std.ArrayList(u8), alloc: std.mem.Allocator, value: []const u8) !void {
    for (value) |c| {
        switch (c) {
            '"' => try out.appendSlice(alloc, "\\\""),
            '\\' => try out.appendSlice(alloc, "\\\\"),
            '\n' => try out.appendSlice(alloc, "\\n"),
            '\r' => try out.appendSlice(alloc, "\\r"),
            '\t' => try out.appendSlice(alloc, "\\t"),
            8 => try out.appendSlice(alloc, "\\b"),
            12 => try out.appendSlice(alloc, "\\f"),
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
                    try out.appendSlice(alloc, buf[0..]);
                } else {
                    try out.append(alloc, c);
                }
            },
        }
    }
}

fn parseRepoId(allocator: std.mem.Allocator, path: []const u8) ?[]u8 {
    if (path.len == 0 or path[0] != '/') return null;
    const trimmed = path[1..];
    const git_idx = std.mem.indexOf(u8, trimmed, ".git") orelse return null;
    return allocator.dupe(u8, trimmed[0..git_idx]) catch null;
}

fn readChunkedBody(alloc: std.mem.Allocator, rdr: *net.Stream.Reader) ![]u8 {
    var body: std.ArrayList(u8) = .empty;
    errdefer body.deinit(alloc);

    while (true) {
        var size_buf: [32]u8 = undefined;
        var size_len: usize = 0;
        while (size_len < size_buf.len) {
            var one: [1]u8 = undefined;
            var bufs = [_][]u8{&one};
            const n = rdr.interface.readVec(&bufs) catch return body.toOwnedSlice(alloc);
            if (n == 0) return body.toOwnedSlice(alloc);
            size_buf[size_len] = one[0];
            size_len += 1;
            if (size_len >= 2 and size_buf[size_len - 2] == '\r' and size_buf[size_len - 1] == '\n')
                break;
        }
        if (size_len < 2) return body.toOwnedSlice(alloc);

        const hex = std.mem.trimEnd(u8, size_buf[0 .. size_len - 2], &[_]u8{ ' ', '\t' });
        const hex_clean = if (std.mem.indexOfScalar(u8, hex, ';')) |si| hex[0..si] else hex;
        const chunk_size = std.fmt.parseInt(usize, hex_clean, 16) catch return body.toOwnedSlice(alloc);

        if (chunk_size == 0) {
            var trail: [2]u8 = undefined;
            var tbufs = [_][]u8{&trail};
            _ = rdr.interface.readVec(&tbufs) catch {};
            break;
        }

        const start = body.items.len;
        try body.resize(alloc, start + chunk_size);
        var got: usize = 0;
        while (got < chunk_size) {
            var dest = [_][]u8{body.items[start + got .. start + chunk_size]};
            const n = rdr.interface.readVec(&dest) catch break;
            if (n == 0) break;
            got += n;
        }

        var crlf: [2]u8 = undefined;
        var cbufs = [_][]u8{&crlf};
        _ = rdr.interface.readVec(&cbufs) catch {};
    }

    return body.toOwnedSlice(alloc);
}

fn sendResponse(io: Io, conn: *net.Stream, status: []const u8, ct: []const u8, body: []const u8, keep_alive: bool) bool {
    return sendResponseWithHeaders(io, conn, status, "", ct, body, keep_alive);
}

fn sendResponseWithHeaders(
    io: Io,
    conn: *net.Stream,
    status: []const u8,
    extra_headers: []const u8,
    ct: []const u8,
    body: []const u8,
    keep_alive: bool,
) bool {
    var h: [512]u8 = undefined;
    const conn_hdr: []const u8 = if (keep_alive) "keep-alive" else "close";
    const hdr = std.fmt.bufPrint(
        &h,
        "HTTP/1.1 {s}\r\n{s}Content-Type: {s}\r\nContent-Length: {d}\r\nCache-Control: no-cache\r\nConnection: {s}\r\n\r\n",
        .{ status, extra_headers, ct, body.len, conn_hdr },
    ) catch return false;
    var wb: [65536]u8 = undefined;
    var w = conn.writer(io, &wb);
    w.interface.writeAll(hdr) catch return false;
    w.interface.writeAll(body) catch return false;
    w.interface.flush() catch return false;
    return keep_alive;
}

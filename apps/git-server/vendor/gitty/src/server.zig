/// Multi-threaded git smart HTTP server using libgitty.
/// Features: HTTP keep-alive, side-band-64k, thread-per-connection.
const std = @import("std");
const protocol = @import("protocol.zig");
const storage_mod = @import("storage.zig");

const Io = std.Io;
const Dir = Io.Dir;
const net = Io.net;
const p = std.debug.print;

pub fn main(init: std.process.Init) !void {
    const alloc = init.gpa;
    const io = init.io;

    var args = std.process.Args.Iterator.init(init.minimal.args);
    _ = args.next();
    const port_str: []const u8 = if (args.next()) |a| a else "9418";
    const data_dir: []const u8 = if (args.next()) |a| a else "/tmp/libgitty-data";
    const port = std.fmt.parseInt(u16, port_str, 10) catch 9418;

    Dir.cwd().createDirPath(io, data_dir) catch {};

    var store = try storage_mod.DiskStorage.init(alloc, io, data_dir);
    defer store.deinit();
    var adapter = store.adapter();

    p("libgitty server on :{d} ({s})\n", .{ port, data_dir });

    var server = try net.IpAddress.listen(.{ .ip4 = .{ .bytes = .{ 0, 0, 0, 0 }, .port = port } }, io, .{ .reuse_address = true });
    defer server.deinit(io);

    while (true) {
        var conn = server.accept(io) catch continue;
        handleConnection(alloc, io, &conn, &adapter);
        conn.close(io);
    }
}

/// Handle a full TCP connection with HTTP keep-alive support.
/// Multiple requests can be served on the same connection.
fn handleConnection(alloc: std.mem.Allocator, io: Io, conn: *net.Stream, adapter: *protocol.StorageAdapter) void {
    var read_buf: [65536]u8 = undefined;
    var rdr = conn.reader(io, &read_buf);
    // Allow up to 10 requests per connection (keep-alive)
    var i: u32 = 0;
    while (i < 10) : (i += 1) {
        const keep = handleRequest(alloc, io, conn, &rdr, adapter) catch break;
        if (!keep) break;
    }
}

/// HTTP request/response types
const Request = struct {
    method: []const u8,
    path: []const u8,
    raw_path: []const u8,
    body: []u8,
    content_length: usize,
    keep_alive: bool,
};

/// Handle a single HTTP request. Returns true if connection should be kept alive.
fn handleRequest(alloc: std.mem.Allocator, io: Io, conn: *net.Stream, rdr: *net.Stream.Reader, adapter: *protocol.StorageAdapter) !bool {
    // Read HTTP headers byte-by-byte to find \r\n\r\n boundary precisely
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

    // Parse request line
    const first_end = std.mem.indexOf(u8, hdr[0..hdr_len], "\r\n") orelse return false;
    const req_line = hdr[0..first_end];
    var parts = std.mem.splitScalar(u8, req_line, ' ');
    _ = parts.next() orelse return false; // method
    const raw_path = parts.next() orelse return false;

    // Parse headers
    var content_length: ?usize = null;
    var chunked = false;
    var keep_alive = true; // HTTP/1.1 default
    var lines = std.mem.splitSequence(u8, hdr[0..hdr_len], "\r\n");
    while (lines.next()) |line| {
        if (std.mem.startsWith(u8, line, "Content-Length: ") or
            std.mem.startsWith(u8, line, "content-length: "))
            content_length = std.fmt.parseInt(usize, line[16..], 10) catch 0;
        if (std.mem.startsWith(u8, line, "Transfer-Encoding: chunked") or
            std.mem.startsWith(u8, line, "transfer-encoding: chunked"))
            chunked = true;
        if (std.mem.startsWith(u8, line, "Connection: close") or
            std.mem.startsWith(u8, line, "connection: close"))
            keep_alive = false;
    }

    // Read body
    var body: []u8 = &.{};
    var body_allocated = false;
    if (chunked) {
        // Chunked transfer encoding: read chunk-size\r\n<data>\r\n...0\r\n\r\n
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

    // Route and respond
    if (std.mem.endsWith(u8, path, "/info/refs")) {
        const is_rp = std.mem.indexOf(u8, raw_path, "service=git-receive-pack") != null;
        const is_up = std.mem.indexOf(u8, raw_path, "service=git-upload-pack") != null;
        const service: []const u8 = if (is_rp) "git-receive-pack" else if (is_up) "git-upload-pack" else {
            sendResponse(io, conn, "403 Forbidden", "text/plain", "Unsupported\n", keep_alive);
            return keep_alive;
        };
        const resp = try protocol.advertiseRefs(alloc, adapter.*, service);
        defer alloc.free(resp);
        var ct: [80]u8 = undefined;
        sendResponse(io, conn, "200 OK", std.fmt.bufPrint(&ct, "application/x-{s}-advertisement", .{service}) catch "application/octet-stream", resp, keep_alive);
    } else if (std.mem.endsWith(u8, path, "/git-receive-pack")) {
        const resp = try protocol.handleReceivePack(alloc, adapter.*, body);
        defer alloc.free(resp);
        sendResponse(io, conn, "200 OK", "application/x-git-receive-pack-result", resp, keep_alive);
    } else if (std.mem.endsWith(u8, path, "/git-upload-pack")) {
        const resp = try protocol.handleUploadPack(alloc, adapter.*, body);
        defer alloc.free(resp);
        sendResponse(io, conn, "200 OK", "application/x-git-upload-pack-result", resp, keep_alive);
    } else {
        sendResponse(io, conn, "200 OK", "application/json", "{\"name\":\"libgitty\",\"version\":\"0.1.0\"}\n", keep_alive);
    }

    return keep_alive;
}

/// Read a chunked transfer-encoded body.
/// Format: <hex-size>\r\n<data>\r\n ... 0\r\n\r\n
fn readChunkedBody(alloc: std.mem.Allocator, rdr: *net.Stream.Reader) ![]u8 {
    var body: std.ArrayList(u8) = .empty;
    errdefer body.deinit(alloc);

    while (true) {
        // Read chunk size line (hex digits followed by \r\n)
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

        // Parse hex chunk size
        const hex = std.mem.trimEnd(u8, size_buf[0 .. size_len - 2], &[_]u8{ ' ', '\t' });
        // Strip chunk extensions (after semicolon)
        const hex_clean = if (std.mem.indexOfScalar(u8, hex, ';')) |si| hex[0..si] else hex;
        const chunk_size = std.fmt.parseInt(usize, hex_clean, 16) catch return body.toOwnedSlice(alloc);

        if (chunk_size == 0) {
            // Terminal chunk — read trailing \r\n
            var trail: [2]u8 = undefined;
            var tbufs = [_][]u8{&trail};
            _ = rdr.interface.readVec(&tbufs) catch {};
            break;
        }

        // Read chunk data
        const start = body.items.len;
        try body.resize(alloc, start + chunk_size);
        var got: usize = 0;
        while (got < chunk_size) {
            var dest = [_][]u8{body.items[start + got .. start + chunk_size]};
            const n = rdr.interface.readVec(&dest) catch break;
            if (n == 0) break;
            got += n;
        }

        // Read trailing \r\n after chunk data
        var crlf: [2]u8 = undefined;
        var cbufs = [_][]u8{&crlf};
        _ = rdr.interface.readVec(&cbufs) catch {};
    }

    return body.toOwnedSlice(alloc);
}

fn sendResponse(io: Io, conn: *net.Stream, status: []const u8, ct: []const u8, body: []const u8, keep_alive: bool) void {
    var h: [512]u8 = undefined;
    const conn_hdr: []const u8 = if (keep_alive) "keep-alive" else "close";
    const hdr = std.fmt.bufPrint(&h, "HTTP/1.1 {s}\r\nContent-Type: {s}\r\nContent-Length: {d}\r\nCache-Control: no-cache\r\nConnection: {s}\r\n\r\n", .{ status, ct, body.len, conn_hdr }) catch return;
    var wb: [65536]u8 = undefined;
    var w = conn.writer(io, &wb);
    w.interface.writeAll(hdr) catch return;
    w.interface.writeAll(body) catch return;
    w.interface.flush() catch return;
}

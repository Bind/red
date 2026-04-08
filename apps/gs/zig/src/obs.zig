const std = @import("std");

pub const RequestRouteKind = enum {
    root,
    control_plane,
    smart_http,
    unknown,
};

pub const RequestObs = struct {
    allocator: std.mem.Allocator,
    started_at_ms: i64,
    started_mono: std.Io.Timestamp,
    request_id: []u8,
    is_request_root: bool,
    event_id: [16]u8,
    method: []const u8,
    path: []const u8,
    host: ?[]const u8,
    scheme: []const u8,
    client_ip: ?[]const u8,
    user_agent: ?[]const u8,
    origin: ?[]const u8,
    referer: ?[]const u8,
    request_content_type: ?[]const u8,
    route_kind: RequestRouteKind = .unknown,
    route_resource: ?[]const u8 = null,
    repo_id: ?[]u8 = null,
    storage_backend: ?[]const u8 = null,
    git_service: ?[]const u8 = null,
    auth_required_access: ?[]const u8 = null,
    auth_outcome: ?[]const u8 = null,
    auth_subject: ?[]const u8 = null,
    response_content_type: ?[]const u8 = null,
    status_code: ?u16 = null,
    error_name: ?[]const u8 = null,
    error_message: ?[]const u8 = null,

    pub fn init(
        allocator: std.mem.Allocator,
        io: std.Io,
        method: []const u8,
        path: []const u8,
        request_id_header: ?[]const u8,
        host: ?[]const u8,
        client_ip: ?[]const u8,
        user_agent: ?[]const u8,
        origin: ?[]const u8,
        referer: ?[]const u8,
        request_content_type: ?[]const u8,
    ) !RequestObs {
        const request_id = if (request_id_header) |value|
            try allocator.dupe(u8, value)
        else
            try generateHexId(allocator);

        return .{
            .allocator = allocator,
            .started_at_ms = @intCast(@divFloor(std.Io.Clock.real.now(io).nanoseconds, std.time.ns_per_ms)),
            .started_mono = std.Io.Clock.awake.now(io),
            .request_id = request_id,
            .is_request_root = request_id_header == null,
            .event_id = timeDerivedId(io),
            .method = method,
            .path = path,
            .host = host,
            .scheme = "http",
            .client_ip = client_ip,
            .user_agent = user_agent,
            .origin = origin,
            .referer = referer,
            .request_content_type = request_content_type,
        };
    }

    pub fn deinit(self: *RequestObs) void {
        if (self.repo_id) |repo_id| self.allocator.free(repo_id);
        self.allocator.free(self.request_id);
    }

    pub fn requestId(self: *const RequestObs) []const u8 {
        return self.request_id;
    }

    pub fn setRoute(self: *RequestObs, kind: RequestRouteKind, resource: ?[]const u8) void {
        self.route_kind = kind;
        self.route_resource = resource;
    }

    pub fn setRepo(self: *RequestObs, repo_id: []const u8, storage_backend: []const u8) void {
        if (self.repo_id) |existing| self.allocator.free(existing);
        self.repo_id = self.allocator.dupe(u8, repo_id) catch null;
        self.storage_backend = storage_backend;
    }

    pub fn setGitService(self: *RequestObs, service: []const u8) void {
        self.git_service = service;
    }

    pub fn setAuthRequired(self: *RequestObs, required_access: []const u8) void {
        self.auth_required_access = required_access;
    }

    pub fn setAuthDecision(self: *RequestObs, outcome: []const u8, subject: ?[]const u8) void {
        self.auth_outcome = outcome;
        self.auth_subject = subject;
    }

    pub fn finish(self: *RequestObs, io: std.Io) void {
        const ended_at_ms: i64 = @intCast(@divFloor(std.Io.Clock.real.now(io).nanoseconds, std.time.ns_per_ms));
        const duration_ms: i64 = @intCast(@divFloor(self.started_mono.durationTo(std.Io.Clock.awake.now(io)).nanoseconds, std.time.ns_per_ms));
        const status_code = self.status_code orelse 500;
        const outcome = if (status_code < 500) "ok" else "error";

        var out: std.Io.Writer.Allocating = .init(self.allocator);
        defer out.deinit();

        writeAll(&out.writer, "{\"id\":\"") catch return;
        writeAll(&out.writer, std.fmt.bytesToHex(self.event_id, .lower)[0..]) catch return;
        writeAll(&out.writer, "\",\"type\":\"request\",\"service\":\"gs\",\"request_id\":\"") catch return;
        writeEscaped(&out.writer, self.request_id) catch return;
        writeAll(&out.writer, "\",\"is_request_root\":") catch return;
        writeAll(&out.writer, if (self.is_request_root) "true" else "false") catch return;
        writeAll(&out.writer, ",\"started_at\":\"") catch return;
        writeIsoFromMs(&out.writer, self.started_at_ms) catch return;
        writeAll(&out.writer, "\",\"ended_at\":\"") catch return;
        writeIsoFromMs(&out.writer, ended_at_ms) catch return;
        writeAll(&out.writer, "\",\"duration_ms\":") catch return;
        out.writer.print("{d}", .{duration_ms}) catch return;
        writeAll(&out.writer, ",\"outcome\":\"") catch return;
        writeAll(&out.writer, outcome) catch return;
        writeAll(&out.writer, "\",\"status_code\":") catch return;
        out.writer.print("{d}", .{status_code}) catch return;
        writeAll(&out.writer, ",\"data\":{") catch return;

        writeAll(&out.writer, "\"request\":{") catch return;
        var first_field = true;
        writeJsonFieldAuto(&out.writer, &first_field, "method", self.method) catch return;
        writeJsonFieldAuto(&out.writer, &first_field, "path", self.path) catch return;
        writeJsonOptionalFieldAuto(&out.writer, &first_field, "host", self.host) catch return;
        writeJsonFieldAuto(&out.writer, &first_field, "scheme", self.scheme) catch return;
        writeAll(&out.writer, "},") catch return;

        writeAll(&out.writer, "\"client\":{") catch return;
        first_field = true;
        writeJsonOptionalFieldAuto(&out.writer, &first_field, "ip", self.client_ip) catch return;
        writeJsonOptionalFieldAuto(&out.writer, &first_field, "user_agent", self.user_agent) catch return;
        writeAll(&out.writer, "},") catch return;

        writeAll(&out.writer, "\"http\":{") catch return;
        first_field = true;
        writeJsonOptionalFieldAuto(&out.writer, &first_field, "origin", self.origin) catch return;
        writeJsonOptionalFieldAuto(&out.writer, &first_field, "referer", self.referer) catch return;
        writeJsonOptionalFieldAuto(&out.writer, &first_field, "content_type", self.request_content_type) catch return;
        writeAll(&out.writer, "}") catch return;

        if (self.route_kind != .unknown or self.route_resource != null) {
            writeAll(&out.writer, ",\"route\":{") catch return;
            first_field = true;
            writeJsonFieldAuto(&out.writer, &first_field, "kind", routeKindName(self.route_kind)) catch return;
            writeJsonOptionalFieldAuto(&out.writer, &first_field, "resource", self.route_resource) catch return;
            writeAll(&out.writer, "}") catch return;
        }

        if (self.repo_id != null or self.storage_backend != null) {
            writeAll(&out.writer, ",\"repo\":{") catch return;
            first_field = true;
            writeJsonOptionalFieldAuto(&out.writer, &first_field, "id", self.repo_id) catch return;
            writeJsonOptionalFieldAuto(&out.writer, &first_field, "storage_backend", self.storage_backend) catch return;
            writeAll(&out.writer, "}") catch return;
        }

        if (self.git_service != null) {
            writeAll(&out.writer, ",\"git\":{") catch return;
            first_field = true;
            writeJsonOptionalFieldAuto(&out.writer, &first_field, "service", self.git_service) catch return;
            writeAll(&out.writer, "}") catch return;
        }

        if (self.auth_required_access != null or self.auth_outcome != null or self.auth_subject != null) {
            writeAll(&out.writer, ",\"auth\":{") catch return;
            first_field = true;
            writeJsonOptionalFieldAuto(&out.writer, &first_field, "required_access", self.auth_required_access) catch return;
            writeJsonOptionalFieldAuto(&out.writer, &first_field, "outcome", self.auth_outcome) catch return;
            writeJsonOptionalFieldAuto(&out.writer, &first_field, "subject", self.auth_subject) catch return;
            writeAll(&out.writer, "}") catch return;
        }

        if (self.response_content_type != null) {
            writeAll(&out.writer, ",\"response\":{") catch return;
            first_field = true;
            writeJsonOptionalFieldAuto(&out.writer, &first_field, "content_type", self.response_content_type) catch return;
            writeAll(&out.writer, "}") catch return;
        }

        if (self.error_name != null or self.error_message != null) {
            writeAll(&out.writer, ",\"error\":{") catch return;
            first_field = true;
            writeJsonOptionalFieldAuto(&out.writer, &first_field, "name", self.error_name) catch return;
            writeJsonOptionalFieldAuto(&out.writer, &first_field, "message", self.error_message) catch return;
            writeAll(&out.writer, "}") catch return;
        }

        writeAll(&out.writer, "}}\n") catch return;
        std.debug.print("{s}", .{out.written()});
    }
};

pub fn setResponse(obs: *RequestObs, status_code: u16, content_type: []const u8) void {
    obs.status_code = status_code;
    obs.response_content_type = content_type;
}

pub fn setError(obs: *RequestObs, err: anyerror) void {
    obs.error_name = @errorName(err);
    obs.error_message = @errorName(err);
}

var next_id: u64 = 1;

fn generateHexId(allocator: std.mem.Allocator) ![]u8 {
    const current = next_id;
    next_id +%= 1;
    var bytes: [16]u8 = undefined;
    std.mem.writeInt(u64, bytes[0..8], current, .big);
    std.mem.writeInt(u64, bytes[8..16], current ^ 0xa5a5a5a5a5a5a5a5, .big);
    return allocator.dupe(u8, std.fmt.bytesToHex(bytes, .lower)[0..]);
}

fn timeDerivedId(io: std.Io) [16]u8 {
    var bytes: [16]u8 = undefined;
    const real_now: u64 = @intCast(std.Io.Clock.real.now(io).nanoseconds);
    const awake_now: u64 = @intCast(std.Io.Clock.awake.now(io).nanoseconds);
    std.mem.writeInt(u64, bytes[0..8], real_now, .big);
    std.mem.writeInt(u64, bytes[8..16], awake_now, .big);
    return bytes;
}

fn routeKindName(kind: RequestRouteKind) []const u8 {
    return switch (kind) {
        .root => "root",
        .control_plane => "control_plane",
        .smart_http => "smart_http",
        .unknown => "unknown",
    };
}

fn writeAll(writer: *std.Io.Writer, bytes: []const u8) !void {
    try writer.writeAll(bytes);
}

fn writeEscaped(writer: *std.Io.Writer, value: []const u8) !void {
    for (value) |c| {
        switch (c) {
            '"' => try writer.writeAll("\\\""),
            '\\' => try writer.writeAll("\\\\"),
            '\n' => try writer.writeAll("\\n"),
            '\r' => try writer.writeAll("\\r"),
            '\t' => try writer.writeAll("\\t"),
            8 => try writer.writeAll("\\b"),
            12 => try writer.writeAll("\\f"),
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
                    try writer.writeAll(buf[0..]);
                } else {
                    try writer.writeByte(c);
                }
            },
        }
    }
}

fn writeJsonFieldAuto(writer: *std.Io.Writer, first: *bool, key: []const u8, value: []const u8) !void {
    if (!first.*) try writer.writeByte(',');
    try writer.writeByte('"');
    try writeEscaped(writer, key);
    try writer.writeAll("\":\"");
    try writeEscaped(writer, value);
    try writer.writeByte('"');
    first.* = false;
}

fn writeJsonOptionalFieldAuto(writer: *std.Io.Writer, first: *bool, key: []const u8, value: ?[]const u8) !void {
    if (value) |actual| {
        try writeJsonFieldAuto(writer, first, key, actual);
    }
}

fn writeIsoFromMs(writer: *std.Io.Writer, epoch_ms: i64) !void {
    const secs: u64 = if (epoch_ms < 0) 0 else @intCast(@divFloor(epoch_ms, std.time.ms_per_s));
    const millis: u64 = if (epoch_ms < 0) 0 else @intCast(@mod(epoch_ms, std.time.ms_per_s));
    const epoch_seconds = std.time.epoch.EpochSeconds{ .secs = secs };
    const year_day = epoch_seconds.getEpochDay().calculateYearDay();
    const month_day = year_day.calculateMonthDay();
    const day_seconds = epoch_seconds.getDaySeconds();
    try writer.print(
        "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}.{d:0>3}Z",
        .{
            year_day.year,
            month_day.month.numeric(),
            month_day.day_index + 1,
            day_seconds.getHoursIntoDay(),
            day_seconds.getMinutesIntoHour(),
            day_seconds.getSecondsIntoMinute(),
            millis,
        },
    );
}

const std = @import("std");

const CollectorSinkConfig = struct {
    endpoint: []u8,
    auth_header: ?[]u8,

    fn deinit(self: *CollectorSinkConfig, allocator: std.mem.Allocator) void {
        allocator.free(self.endpoint);
        if (self.auth_header) |auth_header| allocator.free(auth_header);
    }
};

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

        var data_out: std.Io.Writer.Allocating = .init(self.allocator);
        defer data_out.deinit();
        writeDataObject(self, &data_out.writer) catch return;

        var out: std.Io.Writer.Allocating = .init(self.allocator);
        defer out.deinit();
        writeLegacyLogEvent(self, &out.writer, ended_at_ms, duration_ms, outcome, status_code, data_out.written()) catch return;
        std.debug.print("{s}", .{out.written()});

        const sink_config = loadCollectorSinkConfig(self.allocator) catch |err| {
            std.debug.print("[obs] collector sink config error={s}\n", .{@errorName(err)});
            return;
        };
        if (sink_config) |config| {
            var owned = config;
            defer owned.deinit(self.allocator);
            sendCollectorEvent(self, io, &owned, ended_at_ms, duration_ms, outcome, status_code, data_out.written()) catch |err| {
                std.debug.print("[obs] collector emit failed error={s}\n", .{@errorName(err)});
            };
        }
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

fn writeLegacyLogEvent(
    self: *const RequestObs,
    writer: *std.Io.Writer,
    ended_at_ms: i64,
    duration_ms: i64,
    outcome: []const u8,
    status_code: u16,
    data_json: []const u8,
) !void {
    try writeAll(writer, "{\"id\":\"");
    try writeAll(writer, std.fmt.bytesToHex(self.event_id, .lower)[0..]);
    try writeAll(writer, "\",\"type\":\"request\",\"service\":\"gs\",\"request_id\":\"");
    try writeEscaped(writer, self.request_id);
    try writeAll(writer, "\",\"is_request_root\":");
    try writeAll(writer, if (self.is_request_root) "true" else "false");
    try writeAll(writer, ",\"started_at\":\"");
    try writeIsoFromMs(writer, self.started_at_ms);
    try writeAll(writer, "\",\"ended_at\":\"");
    try writeIsoFromMs(writer, ended_at_ms);
    try writeAll(writer, "\",\"duration_ms\":");
    try writer.print("{d}", .{duration_ms});
    try writeAll(writer, ",\"outcome\":\"");
    try writeAll(writer, outcome);
    try writeAll(writer, "\",\"status_code\":");
    try writer.print("{d}", .{status_code});
    try writeAll(writer, ",\"data\":");
    try writeAll(writer, data_json);
    try writeAll(writer, "}\n");
}

fn writeDataObject(self: *const RequestObs, writer: *std.Io.Writer) !void {
    try writeAll(writer, "{");

    try writeAll(writer, "\"request\":{");
    var first_field = true;
    try writeJsonFieldAuto(writer, &first_field, "method", self.method);
    try writeJsonFieldAuto(writer, &first_field, "path", self.path);
    try writeJsonOptionalFieldAuto(writer, &first_field, "host", self.host);
    try writeJsonFieldAuto(writer, &first_field, "scheme", self.scheme);
    try writeAll(writer, "},");

    try writeAll(writer, "\"client\":{");
    first_field = true;
    try writeJsonOptionalFieldAuto(writer, &first_field, "ip", self.client_ip);
    try writeJsonOptionalFieldAuto(writer, &first_field, "user_agent", self.user_agent);
    try writeAll(writer, "},");

    try writeAll(writer, "\"http\":{");
    first_field = true;
    try writeJsonOptionalFieldAuto(writer, &first_field, "origin", self.origin);
    try writeJsonOptionalFieldAuto(writer, &first_field, "referer", self.referer);
    try writeJsonOptionalFieldAuto(writer, &first_field, "content_type", self.request_content_type);
    try writeAll(writer, "}");

    if (self.route_kind != .unknown or self.route_resource != null) {
        try writeAll(writer, ",\"route\":{");
        first_field = true;
        if (collectorRouteName(self)) |route_name| {
            try writeJsonFieldAuto(writer, &first_field, "name", route_name);
        }
        try writeJsonFieldAuto(writer, &first_field, "kind", routeKindName(self.route_kind));
        try writeJsonOptionalFieldAuto(writer, &first_field, "resource", self.route_resource);
        try writeAll(writer, "}");
    }

    if (self.repo_id != null or self.storage_backend != null) {
        try writeAll(writer, ",\"repo\":{");
        first_field = true;
        try writeJsonOptionalFieldAuto(writer, &first_field, "id", self.repo_id);
        try writeJsonOptionalFieldAuto(writer, &first_field, "storage_backend", self.storage_backend);
        try writeAll(writer, "}");
    }

    if (self.git_service != null) {
        try writeAll(writer, ",\"git\":{");
        first_field = true;
        try writeJsonOptionalFieldAuto(writer, &first_field, "service", self.git_service);
        try writeAll(writer, "}");
    }

    if (self.auth_required_access != null or self.auth_outcome != null or self.auth_subject != null) {
        try writeAll(writer, ",\"auth\":{");
        first_field = true;
        try writeJsonOptionalFieldAuto(writer, &first_field, "required_access", self.auth_required_access);
        try writeJsonOptionalFieldAuto(writer, &first_field, "outcome", self.auth_outcome);
        try writeJsonOptionalFieldAuto(writer, &first_field, "subject", self.auth_subject);
        try writeAll(writer, "}");
    }

    if (self.response_content_type != null) {
        try writeAll(writer, ",\"response\":{");
        first_field = true;
        try writeJsonOptionalFieldAuto(writer, &first_field, "content_type", self.response_content_type);
        try writeAll(writer, "}");
    }

    if (self.error_name != null or self.error_message != null) {
        try writeAll(writer, ",\"error\":{");
        first_field = true;
        try writeJsonOptionalFieldAuto(writer, &first_field, "name", self.error_name);
        try writeJsonOptionalFieldAuto(writer, &first_field, "message", self.error_message);
        try writeAll(writer, "}");
    }

    try writeAll(writer, "}");
}

fn loadCollectorSinkConfig(allocator: std.mem.Allocator) !?CollectorSinkConfig {
    const sink_mode = optionalEnv("OBS_SINK_MODE") orelse return null;
    if (!std.ascii.eqlIgnoreCase(sink_mode, "collector")) return null;

    const base_url = optionalEnv("WIDE_EVENTS_COLLECTOR_URL") orelse return error.MissingCollectorUrl;
    const endpoint = if (std.mem.endsWith(u8, base_url, "/v1/events"))
        try allocator.dupe(u8, base_url)
    else
        try std.fmt.allocPrint(allocator, "{s}/v1/events", .{trimTrailingSlashes(base_url)});
    errdefer allocator.free(endpoint);

    const auth_header = if (optionalEnv("OBS_AUTH_TOKEN")) |token|
        try std.fmt.allocPrint(allocator, "Bearer {s}", .{token})
    else
        null;

    return .{
        .endpoint = endpoint,
        .auth_header = auth_header,
    };
}

fn sendCollectorEvent(
    self: *const RequestObs,
    io: std.Io,
    config: *const CollectorSinkConfig,
    ended_at_ms: i64,
    duration_ms: i64,
    outcome: []const u8,
    status_code: u16,
    data_json: []const u8,
) !void {
    var payload_out: std.Io.Writer.Allocating = .init(self.allocator);
    defer payload_out.deinit();

    try writeAll(&payload_out.writer, "{\"sent_at\":\"");
    try writeIsoFromMs(&payload_out.writer, ended_at_ms);
    try writeAll(&payload_out.writer, "\",\"source\":{\"service\":\"gs\"},\"events\":[{");
    try writeAll(&payload_out.writer, "\"event_id\":\"");
    try writeAll(&payload_out.writer, std.fmt.bytesToHex(self.event_id, .lower)[0..]);
    try writeAll(&payload_out.writer, "\",\"request_id\":\"");
    try writeEscaped(&payload_out.writer, self.request_id);
    try writeAll(&payload_out.writer, "\",\"is_request_root\":");
    try writeAll(&payload_out.writer, if (self.is_request_root) "true" else "false");
    try writeAll(&payload_out.writer, ",\"service\":\"gs\",\"kind\":\"request\",\"ts\":\"");
    try writeIsoFromMs(&payload_out.writer, self.started_at_ms);
    try writeAll(&payload_out.writer, "\",\"ended_at\":\"");
    try writeIsoFromMs(&payload_out.writer, ended_at_ms);
    try writeAll(&payload_out.writer, "\",\"duration_ms\":");
    try payload_out.writer.print("{d}", .{duration_ms});
    try writeAll(&payload_out.writer, ",\"outcome\":\"");
    try writeAll(&payload_out.writer, outcome);
    try writeAll(&payload_out.writer, "\",\"status_code\":");
    try payload_out.writer.print("{d}", .{status_code});
    if (collectorRouteName(self)) |route_name| {
        try writeAll(&payload_out.writer, ",\"route_name\":\"");
        try writeEscaped(&payload_out.writer, route_name);
        try writeAll(&payload_out.writer, "\"");
    }
    if (self.error_name) |error_name| {
        try writeAll(&payload_out.writer, ",\"error_name\":\"");
        try writeEscaped(&payload_out.writer, error_name);
        try writeAll(&payload_out.writer, "\"");
    }
    if (self.error_message) |error_message| {
        try writeAll(&payload_out.writer, ",\"error_message\":\"");
        try writeEscaped(&payload_out.writer, error_message);
        try writeAll(&payload_out.writer, "\"");
    }
    try writeAll(&payload_out.writer, ",\"data\":");
    try writeAll(&payload_out.writer, data_json);
    try writeAll(&payload_out.writer, "}]}\n");

    var client: std.http.Client = .{
        .allocator = self.allocator,
        .io = io,
    };
    defer client.deinit();

    var response_body: std.Io.Writer.Allocating = .init(self.allocator);
    defer response_body.deinit();

    const result = try client.fetch(.{
        .location = .{ .url = config.endpoint },
        .method = .POST,
        .payload = payload_out.written(),
        .response_writer = &response_body.writer,
        .headers = .{
            .content_type = .{ .override = "application/json" },
            .authorization = if (config.auth_header) |value| .{ .override = value } else .omit,
        },
        .keep_alive = false,
    });

    if (result.status.class() != .success) {
        std.debug.print("[obs] collector rejected status={d} body={s}\n", .{
            @intFromEnum(result.status),
            response_body.written(),
        });
        return error.CollectorRejected;
    }
}

fn collectorRouteName(self: *const RequestObs) ?[]const u8 {
    if (self.route_resource) |route_resource| return route_resource;
    return if (self.route_kind == .unknown) null else routeKindName(self.route_kind);
}

fn optionalEnv(name: []const u8) ?[]const u8 {
    var buf: [128]u8 = undefined;
    const c_name = std.fmt.bufPrintZ(&buf, "{s}", .{name}) catch return null;
    const value = std.c.getenv(c_name) orelse return null;
    const span = std.mem.span(value);
    return if (span.len == 0) null else span;
}

fn trimTrailingSlashes(value: []const u8) []const u8 {
    var end = value.len;
    while (end > 0 and value[end - 1] == '/') {
        end -= 1;
    }
    return value[0..end];
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

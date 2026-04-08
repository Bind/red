/// WASM bridge for gitty.
/// Exports git protocol functions callable from JavaScript.
/// Imports host functions for storage (SQLite, R2, etc).
const std = @import("std");
const protocol = @import("protocol.zig");
const object = @import("object.zig");
const pack_mod = @import("pack.zig");

// ---- Host-imported storage functions ----
// These are implemented by the JavaScript host (e.g., Cloudflare Durable Object).
// All byte arrays are passed as (ptr, len) pairs in WASM linear memory.
// Return values written to a host-allocated buffer, returning (ptr << 32 | len) or 0 for null.

extern "env" fn host_get_object(hash_ptr: [*]const u8, hash_len: u32, out_ptr: *[*]u8, out_len: *u32) u32;
extern "env" fn host_put_object(hash_ptr: [*]const u8, hash_len: u32, data_ptr: [*]const u8, data_len: u32) void;
extern "env" fn host_get_ref(name_ptr: [*]const u8, name_len: u32, out_ptr: *[*]u8, out_len: *u32) u32;
extern "env" fn host_set_ref(name_ptr: [*]const u8, name_len: u32, hash_ptr: [*]const u8, hash_len: u32) void;
extern "env" fn host_delete_ref(name_ptr: [*]const u8, name_len: u32) void;
extern "env" fn host_list_refs(out_ptr: *[*]u8, out_len: *u32) void;

// ---- WASM allocator ----
const allocator = std.heap.wasm_allocator;
const MAX_LAST_ERROR_LEN = 256;
var last_error_buf: [MAX_LAST_ERROR_LEN]u8 = undefined;
var last_error_len_value: u32 = 0;

// ---- Exported memory management ----

export fn wasm_alloc(len: u32) ?[*]u8 {
    const buf = allocator.alloc(u8, len) catch return null;
    return buf.ptr;
}

export fn wasm_free(ptr: [*]u8, len: u32) void {
    allocator.free(ptr[0..len]);
}

export fn last_error_ptr() ?[*]const u8 {
    if (last_error_len_value == 0) return null;
    return last_error_buf[0..last_error_len_value].ptr;
}

export fn last_error_len() u32 {
    return last_error_len_value;
}

fn clearLastError() void {
    last_error_len_value = 0;
}

fn setLastError(err: anyerror) void {
    const name = @errorName(err);
    const len = @min(name.len, last_error_buf.len);
    @memcpy(last_error_buf[0..len], name[0..len]);
    last_error_len_value = @intCast(len);
}

// ---- Host storage adapter ----
// Bridges the WASM host functions into gitty's StorageAdapter vtable.

const HostStorage = struct {
    fn getObject(_: *anyopaque, a: std.mem.Allocator, hash: []const u8) anyerror!?[]u8 {
        var out_ptr: [*]u8 = undefined;
        var out_len: u32 = 0;
        const found = host_get_object(hash.ptr, @intCast(hash.len), &out_ptr, &out_len);
        if (found == 0) return null;
        // Copy from host memory to our allocator
        const result = try a.alloc(u8, out_len);
        @memcpy(result, out_ptr[0..out_len]);
        return result;
    }

    fn putObject(_: *anyopaque, hash: []const u8, data: []const u8) anyerror!void {
        host_put_object(hash.ptr, @intCast(hash.len), data.ptr, @intCast(data.len));
    }

    fn getRef(_: *anyopaque, a: std.mem.Allocator, name: []const u8) anyerror!?[]u8 {
        var out_ptr: [*]u8 = undefined;
        var out_len: u32 = 0;
        const found = host_get_ref(name.ptr, @intCast(name.len), &out_ptr, &out_len);
        if (found == 0) return null;
        const result = try a.alloc(u8, out_len);
        @memcpy(result, out_ptr[0..out_len]);
        return result;
    }

    fn setRef(_: *anyopaque, name: []const u8, hash: []const u8) anyerror!void {
        host_set_ref(name.ptr, @intCast(name.len), hash.ptr, @intCast(hash.len));
    }

    fn deleteRef(_: *anyopaque, name: []const u8) anyerror!void {
        host_delete_ref(name.ptr, @intCast(name.len));
    }

    fn listRefs(_: *anyopaque, a: std.mem.Allocator) anyerror![]protocol.Ref {
        var out_ptr: [*]u8 = undefined;
        var out_len: u32 = 0;
        host_list_refs(&out_ptr, &out_len);
        if (out_len == 0) return &.{};

        // Parse refs from host format: "hash name\nhash name\n..."
        const data = out_ptr[0..out_len];
        var result: std.ArrayList(protocol.Ref) = .empty;
        var lines = std.mem.splitScalar(u8, data, '\n');
        while (lines.next()) |line| {
            if (line.len < 41) continue; // min: 40-char hash + space
            const hash_copy = try a.alloc(u8, 40);
            @memcpy(hash_copy, line[0..40]);
            const name_copy = try a.alloc(u8, line.len - 41);
            @memcpy(name_copy, line[41..]);
            try result.append(a, .{ .hash = hash_copy, .name = name_copy });
        }
        return result.toOwnedSlice(a);
    }
};

var host_storage_instance: u8 = 0; // dummy, vtable doesn't use ptr
const host_vtable: protocol.StorageAdapter.VTable = .{
    .getObject = HostStorage.getObject,
    .putObject = HostStorage.putObject,
    .getRef = HostStorage.getRef,
    .setRef = HostStorage.setRef,
    .deleteRef = HostStorage.deleteRef,
    .listRefs = HostStorage.listRefs,
};

fn getAdapter() protocol.StorageAdapter {
    return .{ .ptr = @ptrCast(&host_storage_instance), .vtable = &host_vtable };
}

// ---- Exported protocol functions ----
// Each returns a pointer to the result buffer. Length is written to out_len.
// Caller must free with wasm_free().

/// Advertise refs for git info/refs endpoint.
/// service: "git-receive-pack" or "git-upload-pack"
export fn advertise_refs(service_ptr: [*]const u8, service_len: u32, out_len: *u32) ?[*]u8 {
    clearLastError();
    const service = service_ptr[0..service_len];
    const result = protocol.advertiseRefs(allocator, getAdapter(), service) catch |err| {
        setLastError(err);
        out_len.* = 0;
        return null;
    };
    out_len.* = @intCast(result.len);
    return result.ptr;
}

/// Handle git-receive-pack (push).
export fn handle_receive_pack(body_ptr: [*]const u8, body_len: u32, out_len: *u32) ?[*]u8 {
    clearLastError();
    const body = body_ptr[0..body_len];
    const result = protocol.handleReceivePack(allocator, getAdapter(), body) catch |err| {
        setLastError(err);
        out_len.* = 0;
        return null;
    };
    out_len.* = @intCast(result.len);
    return result.ptr;
}

/// Handle git-upload-pack (fetch/clone).
export fn handle_upload_pack(body_ptr: [*]const u8, body_len: u32, out_len: *u32) ?[*]u8 {
    clearLastError();
    const body = body_ptr[0..body_len];
    const result = protocol.handleUploadPack(allocator, getAdapter(), body) catch |err| {
        setLastError(err);
        out_len.* = 0;
        return null;
    };
    out_len.* = @intCast(result.len);
    return result.ptr;
}

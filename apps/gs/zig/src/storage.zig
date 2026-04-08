/// Disk-based git object storage backend.
/// Stores objects in git's standard format: objects/<hash[0..2]>/<hash[2..]>
/// Refs stored as files: refs/<name> containing the hash.
///
/// This is the Zig equivalent of the TypeScript DiskStorage in bottega,
/// and can serve as the storage backend for the protocol layer.
const std = @import("std");
const sha1_mod = @import("sha1.zig");
const protocol = @import("protocol.zig");

const Io = std.Io;
const Dir = Io.Dir;
const File = Io.File;

pub const DiskStorage = struct {
    root: Dir,
    io: Io,
    allocator: std.mem.Allocator,

    pub fn init(allocator: std.mem.Allocator, io: Io, root_path: []const u8) !DiskStorage {
        // Create root + subdirectories
        Dir.cwd().createDirPath(io, root_path) catch {};
        const root = try Dir.cwd().openDir(io, root_path, .{});
        // Ensure objects/ and refs/ exist
        root.createDir(io, "objects", .default_dir) catch {};
        root.createDir(io, "refs", .default_dir) catch {};
        return .{
            .root = root,
            .io = io,
            .allocator = allocator,
        };
    }

    pub fn deinit(self: *DiskStorage) void {
        @constCast(&self.root).close(self.io);
    }

    /// Get a raw git object by its hex hash.
    pub fn getObject(self: *DiskStorage, allocator: std.mem.Allocator, hash: []const u8) !?[]u8 {
        if (hash.len != 40) return null;
        var path_buf: [64]u8 = undefined;
        const path = std.fmt.bufPrint(&path_buf, "objects/{s}/{s}", .{ hash[0..2], hash[2..] }) catch return null;

        const file = self.root.openFile(self.io, path, .{}) catch return null;
        defer @constCast(&file).close(self.io);

        var read_buf: [65536]u8 = undefined;
        var reader = File.reader(file, self.io, &read_buf);
        return reader.interface.allocRemaining(allocator, .unlimited) catch return null;
    }

    /// Store a raw git object by its hex hash.
    pub fn putObject(self: *DiskStorage, hash: []const u8, data: []const u8) !void {
        if (hash.len != 40) return;

        // Create directory objects/<prefix>/
        var dir_buf: [16]u8 = undefined;
        const dir_path = std.fmt.bufPrint(&dir_buf, "objects/{s}", .{hash[0..2]}) catch return;
        self.root.createDir(self.io, dir_path, .default_dir) catch {};

        var path_buf: [64]u8 = undefined;
        const path = std.fmt.bufPrint(&path_buf, "objects/{s}/{s}", .{ hash[0..2], hash[2..] }) catch return;

        const file = self.root.createFile(self.io, path, .{}) catch return error.WriteError;
        defer @constCast(&file).close(self.io);

        var write_buf: [65536]u8 = undefined;
        var writer = file.writer(self.io, &write_buf);
        writer.interface.writeAll(data) catch return error.WriteError;
        writer.interface.flush() catch return error.WriteError;
    }

    /// Get a ref value by name.
    pub fn getRef(self: *DiskStorage, allocator: std.mem.Allocator, name: []const u8) !?[]u8 {
        var path_buf: [256]u8 = undefined;
        const path = std.fmt.bufPrint(&path_buf, "{s}", .{name}) catch return null;

        const file = self.root.openFile(self.io, path, .{}) catch return null;
        defer @constCast(&file).close(self.io);

        var read_buf: [256]u8 = undefined;
        var reader = File.reader(file, self.io, &read_buf);
        const data = reader.interface.allocRemaining(allocator, .unlimited) catch return null;
        // Trim newline
        const trimmed = std.mem.trimEnd(u8, data, &.{ '\n', '\r', ' ' });
        if (trimmed.len != data.len) {
            const result = try allocator.alloc(u8, trimmed.len);
            @memcpy(result, trimmed);
            allocator.free(data);
            return result;
        }
        return data;
    }

    /// Set a ref value.
    pub fn setRef(self: *DiskStorage, name: []const u8, hash: []const u8) !void {
        var path_buf: [256]u8 = undefined;
        const path = std.fmt.bufPrint(&path_buf, "{s}", .{name}) catch return;

        // Ensure parent directories exist
        // e.g., refs/heads/main needs refs/heads/
        if (std.mem.lastIndexOfScalar(u8, path, '/')) |last_slash| {
            self.root.createDirPath(self.io, path[0..last_slash]) catch {};
        }

        const file = self.root.createFile(self.io, path, .{}) catch return error.WriteError;
        defer @constCast(&file).close(self.io);

        var write_buf: [256]u8 = undefined;
        var writer = file.writer(self.io, &write_buf);
        writer.interface.writeAll(hash) catch return error.WriteError;
        writer.interface.writeAll("\n") catch return error.WriteError;
        writer.interface.flush() catch return error.WriteError;
    }

    /// Delete a ref.
    pub fn deleteRef(self: *DiskStorage, name: []const u8) !void {
        var path_buf: [256]u8 = undefined;
        const path = std.fmt.bufPrint(&path_buf, "{s}", .{name}) catch return;
        self.root.deleteFile(self.io, path) catch {};
    }

    /// List all refs.
    pub fn listRefs(self: *DiskStorage, allocator: std.mem.Allocator) ![]protocol.Ref {
        var result: std.ArrayList(protocol.Ref) = .empty;
        errdefer result.deinit(allocator);

        try self.walkRefs(allocator, &result, "refs");
        return result.toOwnedSlice(allocator);
    }

    fn walkRefs(self: *DiskStorage, allocator: std.mem.Allocator, result: *std.ArrayList(protocol.Ref), prefix: []const u8) !void {
        const dir = self.root.openDir(self.io, prefix, .{ .iterate = true }) catch return;
        defer @constCast(&dir).close(self.io);

        var iter = dir.iterate();
        while (iter.next(self.io) catch null) |entry| {
            var path_buf: [256]u8 = undefined;
            const full = std.fmt.bufPrint(&path_buf, "{s}/{s}", .{ prefix, entry.name }) catch continue;

            if (entry.kind == .directory) {
                // Need stable copy for recursive call since path_buf is on stack
                const sub = try allocator.alloc(u8, full.len);
                defer allocator.free(sub);
                @memcpy(sub, full);
                try self.walkRefs(allocator, result, sub);
            } else {
                // Read the ref content
                if (self.getRef(allocator, full)) |hash_opt| {
                    if (hash_opt) |hash| {
                        const name_copy = try allocator.alloc(u8, full.len);
                        @memcpy(name_copy, full);
                        try result.append(allocator, .{ .name = name_copy, .hash = hash });
                    }
                } else |_| {}
            }
        }
    }

    /// Get a StorageAdapter interface for use with the protocol layer.
    pub fn adapter(self: *DiskStorage) protocol.StorageAdapter {
        return .{
            .ptr = @ptrCast(self),
            .vtable = &vtable,
        };
    }

    const WriteError = error{WriteError};
    const vtable: protocol.StorageAdapter.VTable = .{
        .getObject = getObjectVtable,
        .putObject = putObjectVtable,
        .getRef = getRefVtable,
        .setRef = setRefVtable,
        .deleteRef = deleteRefVtable,
        .listRefs = listRefsVtable,
    };

    fn getObjectVtable(ptr: *anyopaque, a: std.mem.Allocator, hash: []const u8) anyerror!?[]u8 {
        const self: *DiskStorage = @ptrCast(@alignCast(ptr));
        return self.getObject(a, hash);
    }
    fn putObjectVtable(ptr: *anyopaque, hash: []const u8, data: []const u8) anyerror!void {
        const self: *DiskStorage = @ptrCast(@alignCast(ptr));
        return self.putObject(hash, data);
    }
    fn getRefVtable(ptr: *anyopaque, a: std.mem.Allocator, name: []const u8) anyerror!?[]u8 {
        const self: *DiskStorage = @ptrCast(@alignCast(ptr));
        return self.getRef(a, name);
    }
    fn setRefVtable(ptr: *anyopaque, name: []const u8, hash: []const u8) anyerror!void {
        const self: *DiskStorage = @ptrCast(@alignCast(ptr));
        return self.setRef(name, hash);
    }
    fn deleteRefVtable(ptr: *anyopaque, name: []const u8) anyerror!void {
        const self: *DiskStorage = @ptrCast(@alignCast(ptr));
        return self.deleteRef(name);
    }
    fn listRefsVtable(ptr: *anyopaque, a: std.mem.Allocator) anyerror![]protocol.Ref {
        const self: *DiskStorage = @ptrCast(@alignCast(ptr));
        return self.listRefs(a);
    }
};

// No tests here — DiskStorage requires Io which needs process.Init.
// Tested via compat CLI on real repos.

/// SHA-1 — uses ARM SHA1 hardware instructions on Apple Silicon,
/// falls back to std.crypto.hash.Sha1 on other platforms.
const std = @import("std");
const builtin = @import("builtin");

pub const digest_length = 20;
pub const Digest = [digest_length]u8;

const use_hw = builtin.cpu.arch == .aarch64 and
    builtin.zig_backend != .stage2_c and
    builtin.cpu.has(.aarch64, .sha2);
// Note: ARM SHA1 instructions are gated on the "sha2" feature in LLVM,
// not a separate "sha1" feature.

/// Thin wrapper — hardware-accelerated on aarch64, otherwise std.
pub const Sha1 = struct {
    inner: if (use_hw) HwSha1 else std.crypto.hash.Sha1,

    pub fn init() Sha1 {
        return .{ .inner = if (use_hw) HwSha1.init() else std.crypto.hash.Sha1.init(.{}) };
    }

    pub fn update(self: *Sha1, data: []const u8) void {
        self.inner.update(data);
    }

    pub fn final(self: *Sha1) Digest {
        if (use_hw) {
            return self.inner.final();
        } else {
            var out: Digest = undefined;
            self.inner.final(&out);
            return out;
        }
    }

    pub fn hash(data: []const u8) Digest {
        var h = Sha1.init();
        h.update(data);
        return h.final();
    }
};

/// ARM SHA1 hardware-accelerated implementation.
const HwSha1 = struct {
    const V128 = @Vector(4, u32);

    state: V128 = V128{ 0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476 },
    e: u32 = 0xC3D2E1F0,
    buf: [64]u8 = undefined,
    buf_len: u8 = 0,
    total_len: u64 = 0,

    fn init() HwSha1 {
        return .{};
    }

    fn update(self: *HwSha1, data: []const u8) void {
        var input = data;
        self.total_len += input.len;

        if (self.buf_len > 0) {
            const needed: usize = 64 - @as(usize, self.buf_len);
            if (input.len < needed) {
                @memcpy(self.buf[self.buf_len..][0..input.len], input);
                self.buf_len += @intCast(input.len);
                return;
            }
            @memcpy(self.buf[self.buf_len..][0..needed], input[0..needed]);
            self.processBlock(&self.buf);
            input = input[needed..];
            self.buf_len = 0;
        }

        while (input.len >= 64) {
            self.processBlock(input[0..64]);
            input = input[64..];
        }

        if (input.len > 0) {
            @memcpy(self.buf[0..input.len], input);
            self.buf_len = @intCast(input.len);
        }
    }

    fn final(self: *HwSha1) Digest {
        const total_bits = self.total_len * 8;
        self.buf[self.buf_len] = 0x80;
        self.buf_len += 1;

        if (self.buf_len > 56) {
            @memset(self.buf[self.buf_len..64], 0);
            self.processBlock(&self.buf);
            self.buf_len = 0;
        }
        @memset(self.buf[self.buf_len..56], 0);
        std.mem.writeInt(u64, self.buf[56..64], total_bits, .big);
        self.processBlock(&self.buf);

        var result: Digest = undefined;
        const s = @as([4]u32, self.state);
        for (0..4) |i| {
            std.mem.writeInt(u32, result[i * 4 ..][0..4], s[i], .big);
        }
        std.mem.writeInt(u32, result[16..20], self.e, .big);
        return result;
    }

    fn processBlock(self: *HwSha1, block: *const [64]u8) void {
        // Load message schedule as big-endian u32x4
        var w0 = loadBE(block[0..16]);
        var w1 = loadBE(block[16..32]);
        var w2 = loadBE(block[32..48]);
        var w3 = loadBE(block[48..64]);

        var abcd = self.state;
        var e0 = self.e;

        // Save for addition
        const abcd_saved = abcd;
        const e_saved = e0;

        // Rounds 0-3
        var tmp = vaddq(w0, K0());
        e0 = sha1h(abcd[0]);
        abcd = sha1c(abcd, e_saved, tmp);
        w0 = sha1su1(sha1su0(w0, w1, w2), w3);

        // Rounds 4-7
        tmp = vaddq(w1, K0());
        var e1 = sha1h(abcd[0]);
        abcd = sha1c(abcd, e0, tmp);
        w1 = sha1su1(sha1su0(w1, w2, w3), w0);

        // Rounds 8-11
        tmp = vaddq(w2, K0());
        e0 = sha1h(abcd[0]);
        abcd = sha1c(abcd, e1, tmp);
        w2 = sha1su1(sha1su0(w2, w3, w0), w1);

        // Rounds 12-15
        tmp = vaddq(w3, K0());
        e1 = sha1h(abcd[0]);
        abcd = sha1c(abcd, e0, tmp);
        w3 = sha1su1(sha1su0(w3, w0, w1), w2);

        // Rounds 16-19
        tmp = vaddq(w0, K0());
        e0 = sha1h(abcd[0]);
        abcd = sha1c(abcd, e1, tmp);
        w0 = sha1su1(sha1su0(w0, w1, w2), w3);

        // Rounds 20-23
        tmp = vaddq(w1, K1());
        e1 = sha1h(abcd[0]);
        abcd = sha1p(abcd, e0, tmp);
        w1 = sha1su1(sha1su0(w1, w2, w3), w0);

        // Rounds 24-27
        tmp = vaddq(w2, K1());
        e0 = sha1h(abcd[0]);
        abcd = sha1p(abcd, e1, tmp);
        w2 = sha1su1(sha1su0(w2, w3, w0), w1);

        // Rounds 28-31
        tmp = vaddq(w3, K1());
        e1 = sha1h(abcd[0]);
        abcd = sha1p(abcd, e0, tmp);
        w3 = sha1su1(sha1su0(w3, w0, w1), w2);

        // Rounds 32-35
        tmp = vaddq(w0, K1());
        e0 = sha1h(abcd[0]);
        abcd = sha1p(abcd, e1, tmp);
        w0 = sha1su1(sha1su0(w0, w1, w2), w3);

        // Rounds 36-39
        tmp = vaddq(w1, K1());
        e1 = sha1h(abcd[0]);
        abcd = sha1p(abcd, e0, tmp);
        w1 = sha1su1(sha1su0(w1, w2, w3), w0);

        // Rounds 40-43
        tmp = vaddq(w2, K2());
        e0 = sha1h(abcd[0]);
        abcd = sha1m(abcd, e1, tmp);
        w2 = sha1su1(sha1su0(w2, w3, w0), w1);

        // Rounds 44-47
        tmp = vaddq(w3, K2());
        e1 = sha1h(abcd[0]);
        abcd = sha1m(abcd, e0, tmp);
        w3 = sha1su1(sha1su0(w3, w0, w1), w2);

        // Rounds 48-51
        tmp = vaddq(w0, K2());
        e0 = sha1h(abcd[0]);
        abcd = sha1m(abcd, e1, tmp);
        w0 = sha1su1(sha1su0(w0, w1, w2), w3);

        // Rounds 52-55
        tmp = vaddq(w1, K2());
        e1 = sha1h(abcd[0]);
        abcd = sha1m(abcd, e0, tmp);
        w1 = sha1su1(sha1su0(w1, w2, w3), w0);

        // Rounds 56-59
        tmp = vaddq(w2, K2());
        e0 = sha1h(abcd[0]);
        abcd = sha1m(abcd, e1, tmp);
        w2 = sha1su1(sha1su0(w2, w3, w0), w1);

        // Rounds 60-63
        tmp = vaddq(w3, K3());
        e1 = sha1h(abcd[0]);
        abcd = sha1p(abcd, e0, tmp);
        w3 = sha1su1(sha1su0(w3, w0, w1), w2);

        // Rounds 64-67
        tmp = vaddq(w0, K3());
        e0 = sha1h(abcd[0]);
        abcd = sha1p(abcd, e1, tmp);

        // Rounds 68-71
        tmp = vaddq(w1, K3());
        e1 = sha1h(abcd[0]);
        abcd = sha1p(abcd, e0, tmp);

        // Rounds 72-75
        tmp = vaddq(w2, K3());
        e0 = sha1h(abcd[0]);
        abcd = sha1p(abcd, e1, tmp);

        // Rounds 76-79
        tmp = vaddq(w3, K3());
        e1 = sha1h(abcd[0]);
        abcd = sha1p(abcd, e0, tmp);

        // Add saved state
        self.state = abcd +% abcd_saved;
        self.e = e1 +% e_saved;
    }

    // ── ARM NEON SHA1 intrinsics via inline asm ──

    inline fn sha1c(hash_abcd: V128, hash_e: u32, wk: V128) V128 {
        return asm volatile (
            \\sha1c q0, s1, v2.4s
            : [_] "={v0}" (-> V128),
            : [_] "{v0}" (hash_abcd),
              [_] "{s1}" (hash_e),
              [_] "{v2}" (wk),
        );
    }

    inline fn sha1m(hash_abcd: V128, hash_e: u32, wk: V128) V128 {
        return asm volatile (
            \\sha1m q0, s1, v2.4s
            : [_] "={v0}" (-> V128),
            : [_] "{v0}" (hash_abcd),
              [_] "{s1}" (hash_e),
              [_] "{v2}" (wk),
        );
    }

    inline fn sha1p(hash_abcd: V128, hash_e: u32, wk: V128) V128 {
        return asm volatile (
            \\sha1p q0, s1, v2.4s
            : [_] "={v0}" (-> V128),
            : [_] "{v0}" (hash_abcd),
              [_] "{s1}" (hash_e),
              [_] "{v2}" (wk),
        );
    }

    inline fn sha1h(val: u32) u32 {
        return asm (
            \\sha1h s0, s0
            : [_] "={s0}" (-> u32),
            : [_] "{s0}" (val),
        );
    }

    inline fn sha1su0(w0: V128, w1: V128, w2: V128) V128 {
        return asm volatile (
            \\sha1su0 v0.4s, v1.4s, v2.4s
            : [_] "={v0}" (-> V128),
            : [_] "{v0}" (w0),
              [_] "{v1}" (w1),
              [_] "{v2}" (w2),
        );
    }

    inline fn sha1su1(tw: V128, w3: V128) V128 {
        return asm volatile (
            \\sha1su1 v0.4s, v1.4s
            : [_] "={v0}" (-> V128),
            : [_] "{v0}" (tw),
              [_] "{v1}" (w3),
        );
    }

    inline fn vaddq(a: V128, b: V128) V128 {
        return a +% b;
    }

    inline fn loadBE(bytes: *const [16]u8) V128 {
        const raw: V128 = @bitCast(bytes.*);
        if (builtin.cpu.arch.endian() == .little) {
            return @byteSwap(raw);
        }
        return raw;
    }

    inline fn K0() V128 { return @splat(0x5A827999); }
    inline fn K1() V128 { return @splat(0x6ED9EBA1); }
    inline fn K2() V128 { return @splat(0x8F1BBCDC); }
    inline fn K3() V128 { return @splat(0xCA62C1D6); }
};

/// Convert digest to hex string
pub fn digestToHex(digest: *const Digest) [40]u8 {
    const hex_chars = "0123456789abcdef";
    var result: [40]u8 = undefined;
    for (digest.*, 0..) |byte, i| {
        result[i * 2] = hex_chars[byte >> 4];
        result[i * 2 + 1] = hex_chars[byte & 0x0f];
    }
    return result;
}

/// Parse hex string to digest
pub fn hexToDigest(hex: *const [40]u8) !Digest {
    var result: Digest = undefined;
    for (0..20) |i| {
        result[i] = @as(u8, try hexVal(hex[i * 2])) << 4 | @as(u8, try hexVal(hex[i * 2 + 1]));
    }
    return result;
}

fn hexVal(ch: u8) !u4 {
    return switch (ch) {
        '0'...'9' => @intCast(ch - '0'),
        'a'...'f' => @intCast(ch - 'a' + 10),
        'A'...'F' => @intCast(ch - 'A' + 10),
        else => error.InvalidHex,
    };
}

// Tests
test "sha1 empty string" {
    const d = Sha1.hash("");
    const hex = digestToHex(&d);
    try std.testing.expectEqualStrings("da39a3ee5e6b4b0d3255bfef95601890afd80709", &hex);
}

test "sha1 abc" {
    const d = Sha1.hash("abc");
    const hex = digestToHex(&d);
    try std.testing.expectEqualStrings("a9993e364706816aba3e25717850c26c9cd0d89d", &hex);
}

test "sha1 longer message" {
    const d = Sha1.hash("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq");
    const hex = digestToHex(&d);
    try std.testing.expectEqualStrings("84983e441c3bd26ebaae4aa1f95129e5e54670f1", &hex);
}

test "sha1 incremental" {
    var h = Sha1.init();
    h.update("abc");
    h.update("dbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq");
    const d = h.final();
    const hex = digestToHex(&d);
    try std.testing.expectEqualStrings("84983e441c3bd26ebaae4aa1f95129e5e54670f1", &hex);
}

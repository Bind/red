const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // Main library module
    const lib_mod = b.createModule(.{
        .root_source_file = b.path("src/main.zig"),
        .target = target,
        .optimize = optimize,
    });

    // Static library
    const lib = b.addLibrary(.{
        .name = "gitty",
        .root_module = lib_mod,
    });
    b.installArtifact(lib);

    // Tests
    const tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/main.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    const run_tests = b.addRunArtifact(tests);
    const test_step = b.step("test", "Run unit tests");
    test_step.dependOn(&run_tests.step);

    // Benchmark executable
    const bench = b.addExecutable(.{
        .name = "bench",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/bench.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    b.installArtifact(bench);
    const run_bench = b.addRunArtifact(bench);
    const bench_step = b.step("bench", "Run benchmarks");
    bench_step.dependOn(&run_bench.step);

    // Real-repo integration test
    const realtest = b.addExecutable(.{
        .name = "realtest",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/realtest.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    b.installArtifact(realtest);

    // Git HTTP server
    const server = b.addExecutable(.{
        .name = "server",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/server.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    b.installArtifact(server);
    const install_server = b.addInstallArtifact(server, .{});
    const server_only_step = b.step("server-only", "Build only the Git HTTP server");
    server_only_step.dependOn(&install_server.step);

    // Git compat verification CLI
    const compat = b.addExecutable(.{
        .name = "compat",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/compat.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    b.installArtifact(compat);

    // WASM module for Cloudflare Workers / browser
    const wasm_step = b.step("wasm", "Build WASM module");
    const wasm_mod = b.createModule(.{
        .root_source_file = b.path("src/wasm.zig"),
        .target = b.resolveTargetQuery(.{
            .cpu_arch = .wasm32,
            .os_tag = .freestanding,
        }),
        .optimize = optimize,
    });
    wasm_mod.export_symbol_names = &.{
        "wasm_alloc",
        "wasm_free",
        "last_error_ptr",
        "last_error_len",
        "advertise_refs",
        "handle_receive_pack",
        "handle_upload_pack",
    };
    const wasm = b.addExecutable(.{
        .name = "gitty",
        .root_module = wasm_mod,
    });
    wasm.entry = .disabled;
    const install_wasm = b.addInstallArtifact(wasm, .{});
    wasm_step.dependOn(&install_wasm.step);
}

# gitty

A pure Zig git implementation. Zero dependencies beyond the Zig standard library. **38–60x faster** than equivalent Rust implementations.

259KB static binary. 5,500 LOC. 53 tests.

## Features

- **Full git server** — HTTP smart protocol with push, clone, fetch, pull
- **SHA-1** with ARM hardware acceleration (Apple Silicon inline asm), software fallback for other architectures
- **Zlib** compress/decompress via `std.compress.flate`
- **Objects** — blob, tree, commit, tag: parse, build, encode, decode, hash
- **Pack files** — parse (v2, OFS_DELTA + REF_DELTA), build, index (.idx v2), stream indexing
- **Delta compression** — open-addressing hash table, stack-allocated for small bases
- **Protocol** — pkt-line, ref advertisement, receive-pack, upload-pack, side-band-64k, capabilities negotiation, chunked transfer encoding, HTTP keep-alive
- **Diff** — Myers algorithm (line-level), unified output, recursive tree diff
- **Graph** — revList, isAncestor, mergeBase, collectReachableObjects
- **Storage** — DiskStorage backend with vtable interface for custom backends
- **WASM** — compiles to wasm32-freestanding and wasm32-wasi

## Install

Requires **Zig 0.16.0-dev** (0.15.x will not work — broken `std.compress.flate`).

```bash
git clone https://github.com/mattzcarey/gitty.git
cd gitty
zig build test                     # run 53 tests
zig build -Doptimize=ReleaseFast   # build everything
zig build wasm -Doptimize=ReleaseSmall  # build 62KB WASM module
```

### Binaries

After building, all binaries are in `zig-out/bin/`:

| Binary | Description |
|--------|-------------|
| `server` | Git HTTP server |
| `bench` | Benchmark suite |
| `compat` | Verify against real git repos |
| `realtest` | Integration tests with real repos |

### Run the git server

```bash
zig-out/bin/server 8080 /path/to/storage

# then from any git client:
git clone http://localhost:8080/myrepo.git
git push http://localhost:8080/myrepo.git main
```

The server handles push, clone, fetch, pull, branches, tags, and large files (10MB+ tested). Storage is a flat directory of loose objects and refs — compatible with standard git tooling.

### red Observability Contract

The `red` integration emits one JSON wide event per inbound HTTP request from [`src/obs.zig`](src/obs.zig). This behavior should stay aligned with `pkg/obs`.

Sink behavior:

- `OBS_SINK_MODE=collector` with `WIDE_EVENTS_COLLECTOR_URL=http://obs:4090` posts collector batches to `/v1/events`.
- Any other sink mode falls back to the local stdout JSON line for debugging.
- The collector payload uses the canonical obs contract (`event_id`, `kind`, `ts`, `route_name`, `data`), while stdout keeps the legacy debug shape.

Expected request ID behavior:

- If the incoming request already has `x-request-id`, preserve it and emit `is_request_root: false`.
- If the incoming request does not have `x-request-id`, generate one, return it on the response, and emit `is_request_root: true`.
- Use the same `request_id` for the full lifetime of that inbound request.
- Requests arriving from upstream services with an existing `x-request-id` are propagated child events, not new roots.

Expected top-level event fields:

- `id`
- `type = "request"`
- `service = "gs"`
- `request_id`
- `is_request_root`
- `started_at`
- `ended_at`
- `duration_ms`
- `outcome`
- `status_code`

Expected nested `data` fields:

- `request.method`
- `request.path`
- `request.host`
- `request.scheme`
- `client.ip`
- `client.user_agent`
- `http.origin`
- `http.referer`
- `http.content_type`
- `route.kind`
- `route.resource`
- `repo.id`
- `repo.storage_backend`
- `git.service`
- `auth.required_access`
- `auth.outcome`
- `auth.subject`
- `response.content_type`
- `error.name`
- `error.message`

Terminal semantics:

- Emit the event once the inbound request finishes.
- `ended_at` and `status_code` mark the request as terminal.
- Keep `outcome = "ok"` for non-5xx responses and `outcome = "error"` for 5xx responses, matching current `pkg/obs` behavior.
- The obs collector will only immediately finalize a canonical request when `is_request_root: true`; propagated request IDs remain child events unless they later age out by timeout.

### Use as a library

gitty is a single Zig module. Import it in your `build.zig`:

```zig
const gitty_mod = b.dependency("gitty", .{
    .target = target,
    .optimize = optimize,
}).module("gitty");
your_module.addImport("gitty", gitty_mod);
```

Then in your code:

```zig
const gitty = @import("gitty");

// Hash an object
const hash = gitty.hashObject(.blob, "Hello, world!\n");

// Compress/decompress
const compressed = try gitty.zlibCompress(allocator, data, .default_compression);
const decompressed = try gitty.zlibDecompress(allocator, compressed, null);

// Parse a pack file
const entries = try gitty.parsePack(allocator, pack_data);

// Build a pack
const pack = try gitty.buildPack(allocator, &objects);

// Myers diff
const edits = try gitty.diffLines(allocator, old_text, new_text);
const unified = try gitty.formatUnifiedDiff(allocator, "a.txt", "b.txt", old_text, new_text, edits);
```

## Correctness

Verified on the React repository (441,577 objects, depth-50 delta chains). 500 objects cross-checked byte-for-byte against `git cat-file`.

## Git operations tested

All operations verified against the real `git` CLI:

- `git push` (initial + incremental + large files)
- `git clone`
- `git fetch` (clean, no "no common commits" warning)
- `git pull`
- `git push` branches
- `git push --tags`
- `git ls-remote`
- `git log`
- `git diff`
- `git show`
- Round-trip: push from repo A, clone to B, push from B back

## WASM + Cloudflare Workers

gitty compiles to a **62KB WASM module** — run a git server on Cloudflare's edge with Durable Objects + SQLite:

```bash
zig build wasm -Doptimize=ReleaseSmall   # → zig-out/bin/gitty.wasm (62KB)
```

See [`examples/cloudflare-worker/`](examples/cloudflare-worker/) for a complete example — each repo is a Durable Object with SQLite storage. Push, clone, and fetch from anywhere.

The WASM module exports three functions and imports five host storage callbacks:

```
Exports: advertise_refs, handle_receive_pack, handle_upload_pack, wasm_alloc, wasm_free
Imports: host_get_object, host_put_object, host_set_ref, host_delete_ref, host_list_refs
```

Implement the five imports against any storage backend (SQLite, R2, DynamoDB, etc.) and you have a git server.

## Architecture

```
src/
├── main.zig        Public API
├── sha1.zig        SHA-1 (ARM HW + software)
├── deflate.zig     Zlib compress/decompress
├── object.zig      Git object encode/decode/hash
├── delta.zig       Delta compression
├── pack.zig        Pack parse/build/indexPack
├── packindex.zig   Pack index v2
├── packreader.zig  Object resolution from packs
├── protocol.zig    Git smart HTTP protocol
├── diff.zig        Myers diff + tree diff
├── walk.zig        Commit graph operations
├── storage.zig     DiskStorage backend
├── server.zig      HTTP server
├── bench.zig       Benchmarks
├── compat.zig      Compatibility verification
├── realtest.zig    Integration tests
└── tests.zig       Unit tests
```

## License

MIT

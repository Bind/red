# Gitty on Cloudflare Workers

A git server running entirely on Cloudflare's edge network — **62KB WASM module** + Durable Objects + SQLite.

Each git repository is a Durable Object with its own SQLite database. Git objects and refs are stored in two tables. The git protocol logic runs in WebAssembly compiled from gitty's pure Zig implementation.

## Architecture

```
git push/clone/fetch
        │
        ▼
┌─────────────────┐
│  Cloudflare      │
│  Worker          │  Routes requests by repo name
│                  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Durable Object  │  One per repository
│  (GitRepo)       │
│                  │
│  ┌────────────┐  │
│  │ gitty.wasm │  │  62KB — git protocol engine
│  │ (Zig→WASM) │  │
│  └─────┬──────┘  │
│        │         │
│  ┌─────▼──────┐  │
│  │  SQLite    │  │  Built into Durable Objects
│  │  objects   │  │  hash TEXT → data BLOB
│  │  refs      │  │  name TEXT → hash TEXT
│  └────────────┘  │
└─────────────────┘
```

## Setup

### 1. Build the WASM module

From the gitty repo root:

```bash
# Requires Zig 0.16.0-dev
zig build wasm -Doptimize=ReleaseSmall
cp zig-out/bin/gitty.wasm examples/cloudflare-worker/src/gitty.wasm
```

Or use the shortcut:

```bash
cd examples/cloudflare-worker
npm run build-wasm
```

### 2. Install dependencies

```bash
cd examples/cloudflare-worker
npm install
```

### 3. Run locally

```bash
npm run dev
```

### 4. Test with git

```bash
# Push a repo
cd /tmp && mkdir my-project && cd my-project
git init && echo "hello" > README.md
git add -A && git commit -m "initial"
git remote add origin http://localhost:8787/my-project.git
git push origin main

# Clone it back
git clone http://localhost:8787/my-project.git /tmp/cloned
cat /tmp/cloned/README.md  # → "hello"
```

### 5. Deploy

```bash
npm run deploy
```

Then push/clone using your `*.workers.dev` URL.

## How it works

1. **Worker** receives git HTTP requests and extracts the repo name from the URL
2. **Durable Object** is looked up by repo name (one per repo, created on first push)
3. **WASM module** is instantiated with host functions that read/write SQLite
4. Git protocol functions (`advertise_refs`, `handle_receive_pack`, `handle_upload_pack`) run in WASM
5. WASM calls back to JavaScript for storage operations (get/put objects, get/set refs)
6. SQLite stores everything in two tables — objects and refs

The WASM module is 62KB. The entire git protocol — SHA-1, zlib, pack parsing, delta compression, side-band-64k — runs at the edge.

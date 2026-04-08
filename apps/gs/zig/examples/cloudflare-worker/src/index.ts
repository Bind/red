/**
 * Gitty — Git server on Cloudflare Workers + Durable Objects + SQLite.
 *
 * Architecture:
 *   Worker (HTTP routing) → Durable Object (one per repo) → WASM (git protocol) → SQLite (storage)
 *
 * Usage:
 *   git clone https://your-worker.workers.dev/my-repo.git
 *   git push  https://your-worker.workers.dev/my-repo.git main
 */
import gittyWasm from "./gitty.wasm";

interface Env {
	GIT_REPO: DurableObjectNamespace;
}

// ─── Worker ───

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;

		// Extract repo name: /<repo>.git/...
		const match = path.match(/^\/([^/]+\.git)(\/.*)?$/);
		if (!match) {
			return new Response(
				JSON.stringify({ name: "gitty", version: "0.1.0" }),
				{ headers: { "Content-Type": "application/json" } },
			);
		}

		const repoName = match[1]; // e.g. "my-repo.git"
		const repoPath = match[2] || "/"; // e.g. "/info/refs"

		// Route to the Durable Object for this repo
		const id = env.GIT_REPO.idFromName(repoName);
		const stub = env.GIT_REPO.get(id);

		// Forward the request with the repo-relative path
		const doUrl = new URL(request.url);
		doUrl.pathname = repoPath;
		return stub.fetch(new Request(doUrl.toString(), request));
	},
};

// ─── Durable Object (one per git repo) ───

export class GitRepo implements DurableObject {
	private state: DurableObjectState;
	private sql: SqlStorage;
	private wasm: GittyWasm | null = null;

	constructor(state: DurableObjectState) {
		this.state = state;
		this.sql = state.storage.sql;

		// Create tables on first use
		this.sql.exec(`CREATE TABLE IF NOT EXISTS objects (hash TEXT PRIMARY KEY, data BLOB)`);
		this.sql.exec(`CREATE TABLE IF NOT EXISTS refs (name TEXT PRIMARY KEY, hash TEXT NOT NULL)`);
	}

	private getWasm(): GittyWasm {
		if (!this.wasm) {
			this.wasm = instantiateGitty(this.sql);
		}
		return this.wasm;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const path = url.pathname;
		const gitty = this.getWasm();

		// GET /info/refs?service=git-upload-pack|git-receive-pack
		if (path.endsWith("/info/refs")) {
			const service = url.searchParams.get("service");
			if (service !== "git-receive-pack" && service !== "git-upload-pack") {
				return new Response("Unsupported service", { status: 403 });
			}
			const result = gitty.advertiseRefs(service);
			return new Response(result, {
				headers: {
					"Content-Type": `application/x-${service}-advertisement`,
					"Cache-Control": "no-cache",
				},
			});
		}

		// POST /git-receive-pack
		if (path.endsWith("/git-receive-pack") && request.method === "POST") {
			const body = new Uint8Array(await request.arrayBuffer());
			const result = gitty.handleReceivePack(body);
			return new Response(result, {
				headers: {
					"Content-Type": "application/x-git-receive-pack-result",
					"Cache-Control": "no-cache",
				},
			});
		}

		// POST /git-upload-pack
		if (path.endsWith("/git-upload-pack") && request.method === "POST") {
			const body = new Uint8Array(await request.arrayBuffer());
			const result = gitty.handleUploadPack(body);
			return new Response(result, {
				headers: {
					"Content-Type": "application/x-git-upload-pack-result",
					"Cache-Control": "no-cache",
				},
			});
		}

		return new Response("Not found", { status: 404 });
	}
}

// ─── WASM Bridge ───

interface GittyWasm {
	advertiseRefs(service: string): Uint8Array;
	handleReceivePack(body: Uint8Array): Uint8Array;
	handleUploadPack(body: Uint8Array): Uint8Array;
}

/** Read a UTF-8 string from WASM memory */
function readString(memory: WebAssembly.Memory, ptr: number, len: number): string {
	return new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len));
}

/** Write bytes into WASM memory, returning the pointer */
function writeBytes(
	memory: WebAssembly.Memory,
	alloc: (len: number) => number,
	data: Uint8Array,
): number {
	const ptr = alloc(data.length);
	new Uint8Array(memory.buffer, ptr, data.length).set(data);
	return ptr;
}

/** Read a u32 from WASM memory at the given byte offset */
function readU32(memory: WebAssembly.Memory, ptr: number): number {
	return new DataView(memory.buffer).getUint32(ptr, true); // little-endian
}

/** Write a u32 to WASM memory at the given byte offset */
function writeU32(memory: WebAssembly.Memory, ptr: number, value: number): void {
	new DataView(memory.buffer).setUint32(ptr, value, true);
}

/** Write a pointer (u32) to WASM memory */
function writePtr(memory: WebAssembly.Memory, ptr: number, value: number): void {
	new DataView(memory.buffer).setUint32(ptr, value, true);
}

function instantiateGitty(sql: SqlStorage): GittyWasm {
	const encoder = new TextEncoder();

	// We'll fill these in after instantiation
	let memory: WebAssembly.Memory;
	let wasmAlloc: (len: number) => number;
	let wasmFree: (ptr: number, len: number) => void;

	const imports = {
		env: {
			// host_get_object(hash_ptr, hash_len, out_ptr_ptr, out_len_ptr) -> found(u32)
			host_get_object(
				hashPtr: number,
				hashLen: number,
				outPtrPtr: number,
				outLenPtr: number,
			): number {
				const hash = readString(memory, hashPtr, hashLen);
				const row = sql.exec("SELECT data FROM objects WHERE hash = ?", hash).one();
				if (!row) return 0;
				const data = row.data as ArrayBuffer;
				const bytes = new Uint8Array(data);
				const ptr = wasmAlloc(bytes.length);
				new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
				writePtr(memory, outPtrPtr, ptr);
				writeU32(memory, outLenPtr, bytes.length);
				return 1;
			},

			// host_put_object(hash_ptr, hash_len, data_ptr, data_len)
			host_put_object(
				hashPtr: number,
				hashLen: number,
				dataPtr: number,
				dataLen: number,
			): void {
				const hash = readString(memory, hashPtr, hashLen);
				const data = new Uint8Array(memory.buffer, dataPtr, dataLen).slice();
				sql.exec(
					"INSERT OR REPLACE INTO objects (hash, data) VALUES (?, ?)",
					hash,
					data,
				);
			},

			// host_get_ref — not called by current protocol but kept for completeness
			host_get_ref(
				namePtr: number,
				nameLen: number,
				outPtrPtr: number,
				outLenPtr: number,
			): number {
				const name = readString(memory, namePtr, nameLen);
				const row = sql.exec("SELECT hash FROM refs WHERE name = ?", name).one();
				if (!row) return 0;
				const hash = encoder.encode(row.hash as string);
				const ptr = wasmAlloc(hash.length);
				new Uint8Array(memory.buffer, ptr, hash.length).set(hash);
				writePtr(memory, outPtrPtr, ptr);
				writeU32(memory, outLenPtr, hash.length);
				return 1;
			},

			// host_set_ref(name_ptr, name_len, hash_ptr, hash_len)
			host_set_ref(
				namePtr: number,
				nameLen: number,
				hashPtr: number,
				hashLen: number,
			): void {
				const name = readString(memory, namePtr, nameLen);
				const hash = readString(memory, hashPtr, hashLen);
				sql.exec(
					"INSERT OR REPLACE INTO refs (name, hash) VALUES (?, ?)",
					name,
					hash,
				);
			},

			// host_delete_ref(name_ptr, name_len)
			host_delete_ref(namePtr: number, nameLen: number): void {
				const name = readString(memory, namePtr, nameLen);
				sql.exec("DELETE FROM refs WHERE name = ?", name);
			},

			// host_list_refs(out_ptr_ptr, out_len_ptr)
			host_list_refs(outPtrPtr: number, outLenPtr: number): void {
				const rows = sql.exec("SELECT hash, name FROM refs").toArray();
				if (rows.length === 0) {
					writePtr(memory, outPtrPtr, 0);
					writeU32(memory, outLenPtr, 0);
					return;
				}
				// Format: "hash name\nhash name\n..."
				const text = rows.map((r) => `${r.hash} ${r.name}`).join("\n");
				const bytes = encoder.encode(text);
				const ptr = wasmAlloc(bytes.length);
				new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
				writePtr(memory, outPtrPtr, ptr);
				writeU32(memory, outLenPtr, bytes.length);
			},
		},
	};

	const instance = new WebAssembly.Instance(gittyWasm, imports);
	memory = instance.exports.memory as WebAssembly.Memory;
	wasmAlloc = instance.exports.wasm_alloc as (len: number) => number;
	wasmFree = instance.exports.wasm_free as (ptr: number, len: number) => void;

	const advertise_refs = instance.exports.advertise_refs as (
		sPtr: number,
		sLen: number,
		outLen: number,
	) => number;
	const handle_receive_pack = instance.exports.handle_receive_pack as (
		bPtr: number,
		bLen: number,
		outLen: number,
	) => number;
	const handle_upload_pack = instance.exports.handle_upload_pack as (
		bPtr: number,
		bLen: number,
		outLen: number,
	) => number;

	return {
		advertiseRefs(service: string): Uint8Array {
			const sBytes = encoder.encode(service);
			const sPtr = writeBytes(memory, wasmAlloc, sBytes);
			const outLenPtr = wasmAlloc(4);
			const resultPtr = advertise_refs(sPtr, sBytes.length, outLenPtr);
			const outLen = readU32(memory, outLenPtr);
			const result = new Uint8Array(memory.buffer, resultPtr, outLen).slice();
			wasmFree(sPtr, sBytes.length);
			wasmFree(outLenPtr, 4);
			wasmFree(resultPtr, outLen);
			return result;
		},

		handleReceivePack(body: Uint8Array): Uint8Array {
			const bPtr = writeBytes(memory, wasmAlloc, body);
			const outLenPtr = wasmAlloc(4);
			const resultPtr = handle_receive_pack(bPtr, body.length, outLenPtr);
			const outLen = readU32(memory, outLenPtr);
			const result = new Uint8Array(memory.buffer, resultPtr, outLen).slice();
			wasmFree(bPtr, body.length);
			wasmFree(outLenPtr, 4);
			if (outLen > 0) wasmFree(resultPtr, outLen);
			return result;
		},

		handleUploadPack(body: Uint8Array): Uint8Array {
			const bPtr = writeBytes(memory, wasmAlloc, body);
			const outLenPtr = wasmAlloc(4);
			const resultPtr = handle_upload_pack(bPtr, body.length, outLenPtr);
			const outLen = readU32(memory, outLenPtr);
			const result = new Uint8Array(memory.buffer, resultPtr, outLen).slice();
			wasmFree(bPtr, body.length);
			wasmFree(outLenPtr, 4);
			if (outLen > 0) wasmFree(resultPtr, outLen);
			return result;
		},
	};
}

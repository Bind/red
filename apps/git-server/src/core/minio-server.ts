#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SharedSecretGitAuth } from "./auth";

interface GittyWasm {
  advertiseRefs(service: string): Uint8Array;
  handleReceivePack(body: Uint8Array): Uint8Array;
  handleUploadPack(body: Uint8Array): Uint8Array;
}

class GittyWasmError extends Error {
  constructor(
    message: string,
    readonly operation: "advertiseRefs" | "handleReceivePack" | "handleUploadPack"
  ) {
    super(message);
    this.name = "GittyWasmError";
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const publicUrl = requireEnv("GIT_SERVER_PUBLIC_URL");
const port = Number.parseInt(requireEnv("GIT_SERVER_PORT"), 10);
const endpoint = requireEnv("GIT_SERVER_S3_ENDPOINT").replace(/\/+$/g, "");
const bucket = requireEnv("GIT_SERVER_S3_BUCKET");
const prefixRoot = requireEnv("GIT_SERVER_S3_PREFIX").replace(/^\/+|\/+$/g, "");
const region = requireEnv("GIT_SERVER_S3_REGION");
const accessKeyId = requireEnv("GIT_SERVER_S3_ACCESS_KEY_ID");
const secretAccessKey = requireEnv("GIT_SERVER_S3_SECRET_ACCESS_KEY");
const sigv4 = `aws:amz:${region}:s3`;
const authConfig = loadAuthConfig();
const authProvider = new SharedSecretGitAuth(authConfig);

const wasmModule = await loadWasmModule();

const server = Bun.serve({
  port,
  fetch: handleRequest,
});

console.log(`gitty minio wasm server listening on http://0.0.0.0:${server.port}`);
console.log(`public url=${publicUrl}`);
console.log(`minio endpoint=${endpoint} bucket=${bucket} prefix=${prefixRoot}`);

async function handleRequest(request: Request) {
  const url = new URL(request.url);
  const route = parseRepoRoute(url.pathname);

  if (!route) {
    return Response.json({
      name: "gitty-minio",
      version: "0.1.0",
      bucket,
      prefix: prefixRoot,
      mode: "wasm",
      auth: {
        enabled: Boolean(authConfig.adminUsername || authConfig.tokenSecret),
      },
    });
  }

  const authError = authorizeRequest(request, route.repoId);
  if (authError) return authError;

  const gitty = instantiateGitty(route.repoId);

  if (route.repoPath.endsWith("/info/refs")) {
    try {
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
    } catch (error) {
      return internalServerError(request, route.repoId, "advertiseRefs", error);
    }
  }

  if (route.repoPath.endsWith("/git-receive-pack") && request.method === "POST") {
    try {
      const body = new Uint8Array(await request.arrayBuffer());
      const result = gitty.handleReceivePack(body);
      return new Response(result, {
        headers: {
          "Content-Type": "application/x-git-receive-pack-result",
          "Cache-Control": "no-cache",
        },
      });
    } catch (error) {
      return internalServerError(request, route.repoId, "handleReceivePack", error);
    }
  }

  if (route.repoPath.endsWith("/git-upload-pack") && request.method === "POST") {
    try {
      const body = new Uint8Array(await request.arrayBuffer());
      const result = gitty.handleUploadPack(body);
      return new Response(result, {
        headers: {
          "Content-Type": "application/x-git-upload-pack-result",
          "Cache-Control": "no-cache",
        },
      });
    } catch (error) {
      return internalServerError(request, route.repoId, "handleUploadPack", error);
    }
  }

  return new Response("Not found", { status: 404 });
}

interface AuthConfig {
  adminUsername?: string;
  adminPassword?: string;
  tokenSecret?: string;
}

function loadAuthConfig(): AuthConfig {
  return {
    adminUsername: requireEnv("GIT_SERVER_ADMIN_USERNAME"),
    adminPassword: requireEnv("GIT_SERVER_ADMIN_PASSWORD"),
    tokenSecret: requireEnv("GIT_SERVER_AUTH_TOKEN_SECRET"),
  };
}

function authorizeRequest(request: Request, repoId: string) {
  if (!authConfig.adminUsername && !authConfig.tokenSecret) return null;

  const decision = authProvider.authorizeBasicAuth(request.headers.get("authorization"), {
    repoId,
    requiredAccess: getRequiredAccess(request),
  });
  return decision.ok ? null : unauthorized(decision.reason);
}

function getRequiredAccess(request: Request): "read" | "write" {
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname.endsWith("/git-receive-pack")) {
    return "write";
  }
  if (url.pathname.endsWith("/info/refs")) {
    const service = url.searchParams.get("service");
    if (service === "git-receive-pack") return "write";
  }
  return "read";
}

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function unauthorized(message: string) {
  return new Response(message, {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="gitty"',
    },
  });
}

function internalServerError(
  request: Request,
  repoId: string,
  operation: GittyWasmError["operation"],
  error: unknown
) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(
    `[gitty] repo=${repoId} method=${request.method} path=${new URL(request.url).pathname} op=${operation} error=${message}`
  );
  return new Response(`gitty internal error (${operation})`, { status: 500 });
}

function parseRepoRoute(pathname: string) {
  const match = pathname.match(/^\/(.+?\.git)(\/.*)?$/);
  if (!match) return null;

  const repoName = match[1];
  const repoPath = match[2] || "/";
  return {
    repoId: repoName.replace(/\.git$/, ""),
    repoPath,
  };
}

async function loadWasmModule() {
  const wasmPath = join(import.meta.dir, "..", "..", "vendor", "gitty", "zig-out", "bin", "gitty.wasm");
  const wasmBytes = await readFile(wasmPath);
  return new WebAssembly.Module(wasmBytes);
}

function instantiateGitty(repoId: string): GittyWasm {
  let memory: WebAssembly.Memory;
  let wasmAlloc: (len: number) => number;
  let wasmFree: (ptr: number, len: number) => void;

  const imports = {
    env: {
      host_get_object(hashPtr: number, hashLen: number, outPtrPtr: number, outLenPtr: number): number {
        const hash = readString(memory, hashPtr, hashLen);
        const bytes = s3GetBytes(repoObjectKey(repoId, hash));
        if (!bytes) return 0;
        const ptr = wasmAlloc(bytes.length);
        new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
        writePtr(memory, outPtrPtr, ptr);
        writeU32(memory, outLenPtr, bytes.length);
        return 1;
      },
      host_put_object(hashPtr: number, hashLen: number, dataPtr: number, dataLen: number): void {
        const hash = readString(memory, hashPtr, hashLen);
        const data = new Uint8Array(memory.buffer, dataPtr, dataLen).slice();
        s3PutBytes(repoObjectKey(repoId, hash), data);
      },
      host_get_ref(namePtr: number, nameLen: number, outPtrPtr: number, outLenPtr: number): number {
        const name = readString(memory, namePtr, nameLen);
        const bytes = s3GetBytes(repoRefKey(repoId, name));
        if (!bytes) return 0;
        const ptr = wasmAlloc(bytes.length);
        new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes);
        writePtr(memory, outPtrPtr, ptr);
        writeU32(memory, outLenPtr, bytes.length);
        return 1;
      },
      host_set_ref(namePtr: number, nameLen: number, hashPtr: number, hashLen: number): void {
        const name = readString(memory, namePtr, nameLen);
        const hash = readString(memory, hashPtr, hashLen);
        s3PutBytes(repoRefKey(repoId, name), encoder.encode(`${hash}\n`), "text/plain");
      },
      host_delete_ref(namePtr: number, nameLen: number): void {
        const name = readString(memory, namePtr, nameLen);
        s3Delete(repoRefKey(repoId, name));
      },
      host_list_refs(outPtrPtr: number, outLenPtr: number): void {
        const lines: string[] = [];
        for (const key of s3List(repoRefPrefix(repoId))) {
          const refName = `refs/${key.slice(repoRefPrefix(repoId).length)}`;
          const bytes = s3GetBytes(key);
          const hash = bytes ? decoder.decode(bytes).trim() : "";
          if (hash) lines.push(`${hash} ${refName}`);
        }

        const payload = encoder.encode(lines.join("\n"));
        if (payload.length === 0) {
          writePtr(memory, outPtrPtr, 0);
          writeU32(memory, outLenPtr, 0);
          return;
        }

        const ptr = wasmAlloc(payload.length);
        new Uint8Array(memory.buffer, ptr, payload.length).set(payload);
        writePtr(memory, outPtrPtr, ptr);
        writeU32(memory, outLenPtr, payload.length);
      },
    },
  };

  const instance = new WebAssembly.Instance(wasmModule, imports);
  memory = instance.exports.memory as WebAssembly.Memory;
  wasmAlloc = instance.exports.wasm_alloc as (len: number) => number;
  wasmFree = instance.exports.wasm_free as (ptr: number, len: number) => void;
  const last_error_ptr = instance.exports.last_error_ptr as () => number;
  const last_error_len = instance.exports.last_error_len as () => number;

  const advertise_refs = instance.exports.advertise_refs as (sPtr: number, sLen: number, outLen: number) => number;
  const handle_receive_pack = instance.exports.handle_receive_pack as (bPtr: number, bLen: number, outLen: number) => number;
  const handle_upload_pack = instance.exports.handle_upload_pack as (bPtr: number, bLen: number, outLen: number) => number;

  return {
    advertiseRefs(service: string): Uint8Array {
      const sBytes = encoder.encode(service);
      const sPtr = writeBytes(memory, wasmAlloc, sBytes);
      const outLenPtr = normalizeWasmPtr(wasmAlloc(4));
      const resultPtr = normalizeWasmPtr(advertise_refs(sPtr, sBytes.length, outLenPtr));
      const outLen = readU32(memory, outLenPtr);
      const result = readWasmResultBytes(
        memory,
        resultPtr,
        outLen,
        "advertiseRefs",
        last_error_ptr,
        last_error_len
      );
      wasmFree(sPtr, sBytes.length);
      wasmFree(outLenPtr, 4);
      if (outLen > 0) wasmFree(resultPtr, outLen);
      return result;
    },
    handleReceivePack(body: Uint8Array): Uint8Array {
      const bPtr = writeBytes(memory, wasmAlloc, body);
      const outLenPtr = normalizeWasmPtr(wasmAlloc(4));
      const resultPtr = normalizeWasmPtr(handle_receive_pack(bPtr, body.length, outLenPtr));
      const outLen = readU32(memory, outLenPtr);
      const result = readWasmResultBytes(
        memory,
        resultPtr,
        outLen,
        "handleReceivePack",
        last_error_ptr,
        last_error_len
      );
      wasmFree(bPtr, body.length);
      wasmFree(outLenPtr, 4);
      if (outLen > 0) wasmFree(resultPtr, outLen);
      return result;
    },
    handleUploadPack(body: Uint8Array): Uint8Array {
      const bPtr = writeBytes(memory, wasmAlloc, body);
      const outLenPtr = normalizeWasmPtr(wasmAlloc(4));
      const resultPtr = normalizeWasmPtr(handle_upload_pack(bPtr, body.length, outLenPtr));
      const outLen = readU32(memory, outLenPtr);
      const result = readWasmResultBytes(
        memory,
        resultPtr,
        outLen,
        "handleUploadPack",
        last_error_ptr,
        last_error_len
      );
      wasmFree(bPtr, body.length);
      wasmFree(outLenPtr, 4);
      if (outLen > 0) wasmFree(resultPtr, outLen);
      return result;
    },
  };
}

function repoObjectKey(repoId: string, hash: string) {
  return `${repoRoot(repoId)}/objects/${hash.slice(0, 2)}/${hash.slice(2)}`;
}

function repoRefKey(repoId: string, refName: string) {
  return `${repoRoot(repoId)}/${refName}`;
}

function repoRefPrefix(repoId: string) {
  return `${repoRoot(repoId)}/refs/`;
}

function repoRoot(repoId: string) {
  return `${prefixRoot}/${repoId}`;
}

function readString(memory: WebAssembly.Memory, ptr: number, len: number): string {
  return decoder.decode(new Uint8Array(memory.buffer, ptr, len));
}

function writeBytes(memory: WebAssembly.Memory, alloc: (len: number) => number, data: Uint8Array): number {
  const ptr = normalizeWasmPtr(alloc(data.length));
  new Uint8Array(memory.buffer, ptr, data.length).set(data);
  return ptr;
}

function normalizeWasmPtr(value: number): number {
  return value >>> 0;
}

function readWasmResultBytes(
  memory: WebAssembly.Memory,
  ptr: number,
  len: number,
  operation: GittyWasmError["operation"],
  lastErrorPtr: () => number,
  lastErrorLen: () => number
): Uint8Array {
  if (ptr === 0) {
    const message = readWasmErrorMessage(memory, lastErrorPtr, lastErrorLen);
    if (message === null && len === 0) return new Uint8Array();
    const detail = message ?? `WASM returned a null pointer for ${len} bytes`;
    throw new GittyWasmError(`gitty wasm error: ${detail}`, operation);
  }
  if (len === 0) return new Uint8Array();
  return new Uint8Array(memory.buffer, ptr, len).slice();
}

function readWasmErrorMessage(
  memory: WebAssembly.Memory,
  lastErrorPtr: () => number,
  lastErrorLen: () => number
): string | null {
  const len = normalizeWasmPtr(lastErrorLen());
  if (len === 0) return null;
  const ptr = normalizeWasmPtr(lastErrorPtr());
  if (ptr === 0) return null;
  return decoder.decode(new Uint8Array(memory.buffer, ptr, len));
}

function readU32(memory: WebAssembly.Memory, ptr: number): number {
  return new DataView(memory.buffer).getUint32(ptr, true);
}

function writeU32(memory: WebAssembly.Memory, ptr: number, value: number): void {
  new DataView(memory.buffer).setUint32(ptr, value, true);
}

function writePtr(memory: WebAssembly.Memory, ptr: number, value: number): void {
  new DataView(memory.buffer).setUint32(ptr, value, true);
}

function s3GetBytes(key: string): Uint8Array | null {
  const result = runCurl(["-X", "GET", objectUrl(key)]);
  if (result.exitCode === 0) return result.stdout;
  if (looksMissing(result.stderr)) return null;
  throw new Error(`s3 GET failed for ${key}: ${decoder.decode(result.stderr)}`);
}

function s3PutBytes(key: string, data: Uint8Array, contentType = "application/octet-stream") {
  const result = runCurl(
    ["-X", "PUT", "-H", `Content-Type: ${contentType}`, "--data-binary", "@-", objectUrl(key)],
    data
  );
  if (result.exitCode !== 0) {
    throw new Error(`s3 PUT failed for ${key}: ${decoder.decode(result.stderr)}`);
  }
}

function s3Delete(key: string) {
  const result = runCurl(["-X", "DELETE", objectUrl(key)]);
  if (result.exitCode !== 0 && !looksMissing(result.stderr)) {
    throw new Error(`s3 DELETE failed for ${key}: ${decoder.decode(result.stderr)}`);
  }
}

function s3List(prefix: string): string[] {
  const url = `${bucketUrl()}?list-type=2&prefix=${encodeURIComponent(prefix)}`;
  const result = runCurl(["-X", "GET", url]);
  if (result.exitCode !== 0) {
    throw new Error(`s3 LIST failed for ${prefix}: ${decoder.decode(result.stderr)}`);
  }
  const xml = decoder.decode(result.stdout);
  return [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((match) => decodeXml(match[1]));
}

function runCurl(args: string[], stdin?: Uint8Array) {
  return Bun.spawnSync(
    [
      "curl",
      "-fsS",
      "--aws-sigv4",
      sigv4,
      "--user",
      `${accessKeyId}:${secretAccessKey}`,
      ...args,
    ],
    {
      stdin: stdin ? Buffer.from(stdin) : undefined,
      stdout: "pipe",
      stderr: "pipe",
    }
  );
}

function objectUrl(key: string) {
  return `${bucketUrl()}/${encodeKey(key)}`;
}

function bucketUrl() {
  return `${endpoint}/${bucket}`;
}

function encodeKey(key: string) {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function looksMissing(stderr: Uint8Array) {
  const text = decoder.decode(stderr);
  return text.includes("404") || text.includes("NoSuchKey");
}

function decodeXml(value: string) {
  return value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'");
}

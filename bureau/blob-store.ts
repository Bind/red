import { S3Client, write } from "bun";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

export type BlobStoreConfig =
  | {
      kind: "local-fs";
      rootDir: string;
    }
  | {
      kind: "minio";
      endpoint: string;
      port: number;
      useSSL: boolean;
      accessKey: string;
      secretKey: string;
      bucket: string;
      prefix?: string;
    };

export type BlobReadResult = {
  bytes: Uint8Array;
  contentType: string;
};

export type BlobStore = {
  put(sessionId: string, name: string, bytes: Uint8Array): Promise<void>;
  get(sessionId: string, name: string): Promise<BlobReadResult | null>;
  list(sessionId: string): Promise<string[]>;
};

export function createBlobStore(config: BlobStoreConfig): BlobStore {
  if (config.kind === "minio") {
    return createMinioBlobStore(config);
  }
  return createLocalFsBlobStore(config);
}

function createLocalFsBlobStore(config: { rootDir: string }): BlobStore {
  const resolve = (sessionId: string, name: string) => join(config.rootDir, sessionId, name);

  return {
    async put(sessionId, name, bytes) {
      const path = resolve(sessionId, name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
    },

    async get(sessionId, name) {
      const path = resolve(sessionId, name);
      try {
        const bytes = await readFile(path);
        return { bytes: new Uint8Array(bytes), contentType: contentTypeForName(name) };
      } catch (error) {
        if (isMissingFileError(error)) return null;
        throw error;
      }
    },

    async list(sessionId) {
      const sessionDir = join(config.rootDir, sessionId);
      try {
        const entries = await readdir(sessionDir, { recursive: true, withFileTypes: true });
        return entries
          .filter((entry) => entry.isFile())
          .map((entry) => relative(sessionDir, join(entry.parentPath, entry.name)));
      } catch (error) {
        if (isMissingFileError(error)) return [];
        throw error;
      }
    },
  };
}

function createMinioBlobStore(config: {
  endpoint: string;
  port: number;
  useSSL: boolean;
  accessKey: string;
  secretKey: string;
  bucket: string;
  prefix?: string;
}): BlobStore {
  const client = new S3Client({
    endpoint: `${config.useSSL ? "https" : "http"}://${config.endpoint}:${config.port}`,
    bucket: config.bucket,
    accessKeyId: config.accessKey,
    secretAccessKey: config.secretKey,
  });
  const prefix = trimSlashes(config.prefix ?? "bureau-blobs");
  const keyFor = (sessionId: string, name: string) => joinKey(prefix, sessionId, name);
  const sessionPrefix = (sessionId: string) => `${joinKey(prefix, sessionId)}/`;

  return {
    async put(sessionId, name, bytes) {
      await write(
        client.file(keyFor(sessionId, name), { type: contentTypeForName(name) }),
        bytes,
      );
    },

    async get(sessionId, name) {
      const key = keyFor(sessionId, name);
      try {
        const file = client.file(key);
        const buffer = await file.arrayBuffer();
        return { bytes: new Uint8Array(buffer), contentType: contentTypeForName(name) };
      } catch {
        return null;
      }
    },

    async list(sessionId) {
      const sp = sessionPrefix(sessionId);
      const result = await client.list({ prefix: sp });
      const contents = result?.contents ?? [];
      return contents
        .map((entry) => entry.key)
        .filter((key): key is string => typeof key === "string" && key.startsWith(sp))
        .map((key) => key.slice(sp.length));
    },
  };
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

export function contentTypeForName(name: string): string {
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".jsonl")) return "application/x-ndjson";
  if (name.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (name.endsWith(".txt")) return "text/plain; charset=utf-8";
  if (name.endsWith(".diff") || name.endsWith(".patch")) return "text/x-diff; charset=utf-8";
  return "application/octet-stream";
}

function joinKey(...parts: string[]): string {
  return parts.map(trimSlashes).filter(Boolean).join("/");
}

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

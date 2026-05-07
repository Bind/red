import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

export type BlobStoreConfig = {
  kind: "local-fs";
  rootDir: string;
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
  const resolve = (sessionId: string, name: string) =>
    join(config.rootDir, sessionId, name);

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

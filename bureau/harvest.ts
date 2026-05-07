import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { BlobStore } from "./blob-store";

export async function harvestBureauOut(input: {
  workspaceDir: string;
  sessionId: string;
  store: BlobStore;
}): Promise<string[]> {
  const outDir = join(input.workspaceDir, ".bureau-out");
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(outDir, { recursive: true, withFileTypes: true });
  } catch (error) {
    if (isMissingFileError(error)) return [];
    throw error;
  }

  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const fullPath = join(entry.parentPath, entry.name);
    const name = relativeName(outDir, fullPath);
    const bytes = new Uint8Array(await readFile(fullPath));
    await input.store.put(input.sessionId, name, bytes);
    names.push(name);
  }
  return names;
}

function relativeName(outDir: string, fullPath: string): string {
  const prefix = `${outDir}/`;
  return fullPath.startsWith(prefix) ? fullPath.slice(prefix.length) : fullPath;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

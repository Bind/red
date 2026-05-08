// Integration tests for the MinIO blob store adapter.
//
// Excluded from the default `bun test` run via the `.integration.ts` suffix
// (per CLAUDE.md). Run with `bun test bureau/blob-store.integration.ts` while
// the dev compose stack is up:
//
//   just dev-up      # or whatever brings MinIO online
//   bun test bureau/blob-store.integration.ts
//
// Required env vars (defaults match `infra/dev/compose.yml`):
//   MINIO_ENDPOINT, MINIO_PORT, MINIO_USE_SSL,
//   MINIO_ACCESS_KEY, MINIO_SECRET_KEY, MINIO_BUCKET

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createBlobStore } from "./blob-store";

const required = (key: string): string => {
  const value = process.env[key];
  if (!value) throw new Error(`integration test requires env var ${key}`);
  return value;
};

let prefix: string;

beforeEach(() => {
  prefix = `bureau-blobs-test/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
});

afterEach(() => {
  // No explicit cleanup — MinIO retains test objects under the unique prefix.
  // Ops can prune them by re-running the bucket creation step or via mc.
});

const minioConfig = () =>
  ({
    kind: "minio" as const,
    endpoint: required("MINIO_ENDPOINT"),
    port: Number.parseInt(required("MINIO_PORT"), 10),
    useSSL: required("MINIO_USE_SSL").toLowerCase() === "true",
    accessKey: required("MINIO_ACCESS_KEY"),
    secretKey: required("MINIO_SECRET_KEY"),
    bucket: required("MINIO_BUCKET"),
    prefix,
  });

describe("createBlobStore (minio)", () => {
  test("put then get round-trips a payload for a (sessionId, name)", async () => {
    const store = createBlobStore(minioConfig());
    const payload = new TextEncoder().encode("hello minio");

    await store.put("ses-abc", "summary.md", payload);
    const result = await store.get("ses-abc", "summary.md");

    expect(result).not.toBeNull();
    expect(result?.bytes).toEqual(payload);
    expect(result?.contentType).toBe("text/markdown; charset=utf-8");
  });

  test("get returns null for a name that has not been put", async () => {
    const store = createBlobStore(minioConfig());
    await expect(store.get("ses-abc", "missing.md")).resolves.toBeNull();
  });

  test("list returns the names that have been put under a sessionId", async () => {
    const store = createBlobStore(minioConfig());
    const payload = new TextEncoder().encode("x");

    await store.put("ses-abc", "summary.md", payload);
    await store.put("ses-abc", "diffs/auth.diff", payload);
    await store.put("ses-other", "isolated.md", payload);

    const names = await store.list("ses-abc");
    expect(names.sort()).toEqual(["diffs/auth.diff", "summary.md"]);
  });
});

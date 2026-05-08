import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBlobStore } from "./blob-store";

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "bureau-blob-store-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("createBlobStore (local-fs)", () => {
  test("put then get round-trips a payload for a (sessionId, name)", async () => {
    const store = createBlobStore({ kind: "local-fs", rootDir });
    const sessionId = "ses-abc";
    const name = "summary.md";
    const payload = new TextEncoder().encode("hello world");

    await store.put(sessionId, name, payload);
    const result = await store.get(sessionId, name);

    expect(result).not.toBeNull();
    expect(result?.bytes).toEqual(payload);
  });

  test("get returns null for a name that has not been put", async () => {
    const store = createBlobStore({ kind: "local-fs", rootDir });
    await expect(store.get("ses-abc", "missing.md")).resolves.toBeNull();
  });

  test("list returns the names that have been put under a sessionId", async () => {
    const store = createBlobStore({ kind: "local-fs", rootDir });
    const payload = new TextEncoder().encode("x");

    await store.put("ses-abc", "summary.md", payload);
    await store.put("ses-abc", "result.json", payload);
    await store.put("ses-other", "isolated.md", payload);

    const names = await store.list("ses-abc");
    expect(names.sort()).toEqual(["result.json", "summary.md"]);
  });

  test("put with the same name overwrites the previous payload", async () => {
    const store = createBlobStore({ kind: "local-fs", rootDir });
    const first = new TextEncoder().encode("first");
    const second = new TextEncoder().encode("second");

    await store.put("ses-abc", "summary.md", first);
    await store.put("ses-abc", "summary.md", second);

    const result = await store.get("ses-abc", "summary.md");
    expect(result?.bytes).toEqual(second);
  });

  test("name accepts path-like values and round-trips through get and list", async () => {
    const store = createBlobStore({ kind: "local-fs", rootDir });
    const payload = new TextEncoder().encode("diff content");

    await store.put("ses-abc", "diffs/auth.diff", payload);

    const result = await store.get("ses-abc", "diffs/auth.diff");
    expect(result?.bytes).toEqual(payload);

    const names = await store.list("ses-abc");
    expect(names).toEqual(["diffs/auth.diff"]);
  });

  test("get returns a contentType derived from the name extension", async () => {
    const store = createBlobStore({ kind: "local-fs", rootDir });

    await store.put("ses-abc", "summary.md", new TextEncoder().encode("# title"));
    await store.put("ses-abc", "result.json", new TextEncoder().encode("{}"));
    await store.put("ses-abc", "events.jsonl", new TextEncoder().encode("{}\n"));
    await store.put("ses-abc", "raw.bin", new TextEncoder().encode("opaque"));

    expect((await store.get("ses-abc", "summary.md"))?.contentType).toBe(
      "text/markdown; charset=utf-8",
    );
    expect((await store.get("ses-abc", "result.json"))?.contentType).toBe("application/json");
    expect((await store.get("ses-abc", "events.jsonl"))?.contentType).toBe("application/x-ndjson");
    expect((await store.get("ses-abc", "raw.bin"))?.contentType).toBe("application/octet-stream");
  });
});

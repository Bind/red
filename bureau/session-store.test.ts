import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalBureauSessionStore, type PiSessionSnapshot } from "./session-store";

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "bureau-session-store-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("createLocalBureauSessionStore", () => {
  test("creates and reloads a root session from the local bureau session store", async () => {
    const store = createLocalBureauSessionStore({ rootDir });
    const snapshot: PiSessionSnapshot = {
      version: 1,
      systemPrompt: "You are a bureau agent.",
      messages: [{ role: "user", content: "hello" }],
    };

    const created = await store.createRoot({
      agentName: "daemon-executor",
      args: { daemonName: "docs-command-surface" },
      snapshot,
    });

    expect(created.meta.sessionId).toBeString();
    expect(created.meta.parentSessionId).toBeNull();

    const sessionPath = join(rootDir, ".bureau", "sessions", created.meta.sessionId, "session.json");
    const metaPath = join(rootDir, ".bureau", "sessions", created.meta.sessionId, "meta.json");

    expect(JSON.parse(await readFile(sessionPath, "utf8"))).toEqual(snapshot);
    expect(JSON.parse(await readFile(metaPath, "utf8"))).toMatchObject({
      sessionId: created.meta.sessionId,
      parentSessionId: null,
      agentName: "daemon-executor",
      args: { daemonName: "docs-command-surface" },
    });

    await expect(store.get(created.meta.sessionId)).resolves.toEqual(created);
  });

  test("lists persisted root sessions by scanning metadata files", async () => {
    const store = createLocalBureauSessionStore({ rootDir });

    const alpha = await store.createRoot({
      agentName: "daemon-executor",
      args: { daemonName: "docs-command-surface" },
      mode: "run",
      snapshot: {
        version: 1,
        systemPrompt: "daemon executor prompt",
        messages: [],
      },
    });
    const beta = await store.createRoot({
      agentName: "librarian",
      args: null,
      mode: "onboard",
      snapshot: {
        version: 1,
        systemPrompt: "librarian prompt",
        messages: [],
      },
    });

    const all = await store.list();
    expect(all.map((entry) => entry.sessionId).sort()).toEqual(
      [alpha.meta.sessionId, beta.meta.sessionId].sort(),
    );

    await expect(store.list({ agentName: "daemon-executor" })).resolves.toEqual([alpha.meta]);
    await expect(store.list({ mode: "onboard" })).resolves.toEqual([beta.meta]);
    await expect(store.list({ parentSessionId: null })).resolves.toEqual(
      expect.arrayContaining([alpha.meta, beta.meta]),
    );
  });
});

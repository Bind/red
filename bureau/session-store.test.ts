import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

  test("createRoot persists workspaceRef, output, and blobs on the meta", async () => {
    const store = createLocalBureauSessionStore({ rootDir });

    const created = await store.createRoot({
      agentName: "summarize-change",
      args: { changeId: 42 },
      snapshot: {
        version: 1,
        systemPrompt: "summarize",
        messages: [],
      },
      workspaceRef: "refs/bureau/sessions/abc123",
      output: { summary: "looks good" },
      blobs: ["summary.md", "result.json"],
    });

    expect(created.meta.workspaceRef).toBe("refs/bureau/sessions/abc123");
    expect(created.meta.output).toEqual({ summary: "looks good" });
    expect(created.meta.blobs).toEqual(["summary.md", "result.json"]);

    const reloaded = await store.get(created.meta.sessionId);
    expect(reloaded?.meta).toEqual(created.meta);
  });

  test("get reads legacy meta files that predate the workspaceRef/output/blobs fields", async () => {
    const sessionId = "legacy-ses-1";
    const sessionDir = join(rootDir, ".bureau", "sessions", sessionId);
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, "session.json"),
      JSON.stringify({ version: 1, systemPrompt: "old", messages: [] }),
    );
    await writeFile(
      join(sessionDir, "meta.json"),
      JSON.stringify({
        sessionId,
        parentSessionId: null,
        agentName: "legacy-agent",
        args: null,
        mode: null,
        sourceSha: null,
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      }),
    );

    const store = createLocalBureauSessionStore({ rootDir });
    const reloaded = await store.get(sessionId);

    expect(reloaded).not.toBeNull();
    expect(reloaded?.meta.workspaceRef).toBeUndefined();
    expect(reloaded?.meta.output).toBeUndefined();
    expect(reloaded?.meta.blobs).toBeUndefined();
    expect(reloaded?.meta.agentName).toBe("legacy-agent");
  });

  test("createChild persists workspaceRef, output, and blobs on the meta", async () => {
    const store = createLocalBureauSessionStore({ rootDir });

    const parent = await store.createRoot({
      agentName: "triage-analyze",
      args: { rollupId: "r-1" },
      snapshot: { version: 1, systemPrompt: "analyze", messages: [] },
    });

    const child = await store.createChild({
      parentSessionId: parent.meta.sessionId,
      agentName: "triage-propose",
      args: { plan: "..." },
      snapshot: { version: 1, systemPrompt: "propose", messages: [] },
      workspaceRef: "refs/bureau/sessions/child-xyz",
      output: { branch: "agent/fix-42", summary: "..." },
      blobs: ["proposal.md"],
    });

    expect(child.meta.parentSessionId).toBe(parent.meta.sessionId);
    expect(child.meta.workspaceRef).toBe("refs/bureau/sessions/child-xyz");
    expect(child.meta.output).toEqual({ branch: "agent/fix-42", summary: "..." });
    expect(child.meta.blobs).toEqual(["proposal.md"]);

    const reloaded = await store.get(child.meta.sessionId);
    expect(reloaded?.meta).toEqual(child.meta);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentProvider, ProviderRunOptions, ProviderRunResult } from "../../../pkg/daemons/src/providers/types";
import type { DaemonSpec } from "../../../pkg/daemons/src/loader";
import { daemonExecutor } from "./agent";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "bureau-daemon-executor-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("daemonExecutor", () => {
  test("persists a bureau session for daemon-backed execution", async () => {
    const trustedRoot = join(dir, "trusted");
    const reviewRoot = join(dir, "review");
    const scopeRel = join("apps", "docs");
    const specFileRel = join(scopeRel, "docs-command-surface.daemon.md");
    const trustedSpecFile = join(trustedRoot, specFileRel);
    const reviewSpecFile = join(reviewRoot, specFileRel);
    const scopeRoot = dirname(trustedSpecFile);

    await mkdir(dirname(trustedSpecFile), { recursive: true });
    await mkdir(dirname(reviewSpecFile), { recursive: true });
    await writeFile(trustedSpecFile, "daemon source\n");
    await writeFile(reviewSpecFile, "daemon review source\n");

    await Bun.$`git init -q ${reviewRoot}`.quiet();
    await Bun.$`git -C ${reviewRoot} add -A`.quiet();
    await Bun.$`git -C ${reviewRoot} -c user.email=test@example.com -c user.name=test -c commit.gpgsign=false commit -q -m baseline`.quiet();

    const spec: DaemonSpec = {
      name: "docs-command-surface",
      description: "checks docs command surface",
      file: trustedSpecFile,
      scopeRoot,
      body: "Audit the changed docs command surface.",
      review: {
        maxTurns: 3,
        routingCategories: [],
      },
    };

    const provider: AgentProvider = {
      name: "fake",
      async runUntilComplete(opts: ProviderRunOptions): Promise<ProviderRunResult> {
        return {
          ok: true,
          payload: {
            summary: "completed daemon review",
            findings: [],
          },
          turns: 1,
          tokens: { input: 7, output: 11 },
          session: {
            systemPrompt: opts.systemPrompt,
            messages: [
              { role: "user", content: opts.initialInput },
              { role: "assistant", content: "all clear" },
            ],
          },
        };
      },
    };

    const executor = daemonExecutor({
      async loadMemorySnapshot() {
        return null;
      },
      async createDaemonMemoryStore() {
        return {
          daemon: spec.name,
          scopeRoot: join(reviewRoot, scopeRel),
          lookup() {
            return [];
          },
          async record() {},
          async invalidate() {
            return 0;
          },
          snapshot() {
            return {
              version: 3,
              daemonContractVersion: 1,
              daemon: spec.name,
              scopeRoot: join(reviewRoot, scopeRel),
              repoRoot: reviewRoot,
              repoId: "test/repo",
              commit: null,
              baseCommit: null,
              updatedAt: new Date().toISOString(),
              tracked: {},
              lastRun: {
                summary: "",
                findings: [],
                checkedFiles: [],
                fileInventory: [],
              },
            };
          },
        };
      },
      createTrackTool() {
        return {
          name: "track",
          description: "track",
          parameters: { type: "object", properties: {} },
          execute: async () => ({}),
        };
      },
      async saveMemoryRecord() {},
      async saveDaemonRun() {},
      createEmptyMemoryRecord() {
        return {
          tracked: {},
        } as any;
      },
      async collectCheckedFiles() {
        return [];
      },
      async collectScopeInventory() {
        return [];
      },
      createPiProvider() {
        return provider;
      },
    });

    const outcome = await executor.run({
      spec,
      trustedRoot,
      reviewRoot,
      relevantFiles: ["apps/docs/README.md"],
    });

    expect(outcome.ok).toBe(true);

    const sessionsRoot = join(reviewRoot, ".bureau", "sessions");
    const sessionIds = await readdir(sessionsRoot);
    expect(sessionIds).toHaveLength(1);

    const session = JSON.parse(
      await readFile(join(sessionsRoot, sessionIds[0]!, "session.json"), "utf8"),
    );
    const meta = JSON.parse(
      await readFile(join(sessionsRoot, sessionIds[0]!, "meta.json"), "utf8"),
    );

    expect(session.version).toBe(1);
    expect(session.messages).toHaveLength(2);
    expect(meta.agentName).toBe("daemon-executor");
    expect(meta.args).toEqual({
      daemonName: "docs-command-surface",
      relevantFiles: ["apps/docs/README.md"],
    });
  });
});

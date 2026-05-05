import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentProvider, ProviderRunOptions, ProviderRunResult } from "../pkg/daemons/src/providers/types";
import { runBureauAgent } from "./runtime";
import { resolveBureauAgent } from "./resolve-agent";

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "bureau-resolve-agent-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("resolveBureauAgent", () => {
  test("resolves librarian into a runnable generic session spec", async () => {
    const resolved = await resolveBureauAgent({
      agentName: "librarian",
      args: {
        file: "apps/ctl/index.ts",
        fileSummary: "CLI entrypoint",
        candidates: [],
      },
      root: rootDir,
    });

    expect(resolved.agentName).toBe("librarian");
    expect(resolved.args).toEqual({
      file: "apps/ctl/index.ts",
      fileSummary: "CLI entrypoint",
      candidates: [],
    });
    expect(resolved.context.name).toBe("librarian");
    expect(resolved.context.root).toBe(rootDir);
    expect(resolved.context.cwd).toBe(rootDir);

    const plan = await resolved.definition.run({
      ...resolved.context,
      sessionId: "ses_test",
      input: resolved.args,
    });

    expect(plan.systemPrompt).toContain("routing librarian");
    expect(plan.initialInput).toContain("\"file\": \"apps/ctl/index.ts\"");
  });

  test("resolves daemon-executor from raw JSON args into a runnable generic session spec", async () => {
    const daemonFile = join(rootDir, "apps", "docs", "docs-command-surface.daemon.md");
    await mkdir(dirname(daemonFile), { recursive: true });
    await writeFile(
      daemonFile,
      [
        "---",
        "name: docs-command-surface",
        "description: checks docs command surface",
        "---",
        "Audit the changed docs command surface.",
      ].join("\n"),
    );

    const resolved = await resolveBureauAgent({
      agentName: "daemon-executor",
      args: {
        daemonName: "docs-command-surface",
        relevantFiles: ["apps/docs/README.md"],
      },
      root: rootDir,
    });

    expect(resolved.agentName).toBe("daemon-executor");
    expect(resolved.args).toEqual({
      daemonName: "docs-command-surface",
      relevantFiles: ["apps/docs/README.md"],
    });
    expect(resolved.context.name).toBe("daemon-executor");
    expect(resolved.context.root).toBe(rootDir);
    expect(resolved.context.cwd).toBe(rootDir);

    const builtInput = resolved.buildInput("hi from operator");
    expect(builtInput).toEqual({
      args: {
        daemonName: "docs-command-surface",
        relevantFiles: ["apps/docs/README.md"],
      },
      userInput: "hi from operator",
    });

    const plan = await resolved.definition.run({
      ...resolved.context,
      sessionId: "ses_test",
      input: builtInput,
    });

    expect(plan.systemPrompt).toContain("docs-command-surface");
    expect(plan.systemPrompt).toContain("Audit the changed docs command surface.");
    expect(plan.initialInput).toContain("Changed files relevant to this daemon:");
    expect(plan.initialInput).toContain("apps/docs/README.md");
    expect(plan.initialInput).toContain("User request:\nhi from operator");
  });

  test("runs daemon-executor through the generic bureau runtime and persists bureau session artifacts", async () => {
    const daemonFile = join(rootDir, "apps", "docs", "docs-command-surface.daemon.md");
    await mkdir(dirname(daemonFile), { recursive: true });
    await writeFile(
      daemonFile,
      [
        "---",
        "name: docs-command-surface",
        "description: checks docs command surface",
        "---",
        "Audit the changed docs command surface.",
      ].join("\n"),
    );

    const args = {
      daemonName: "docs-command-surface",
      relevantFiles: ["apps/docs/README.md"],
    };

    const resolved = await resolveBureauAgent({
      agentName: "daemon-executor",
      args,
      root: rootDir,
    });

    const provider: AgentProvider = {
      name: "fake",
      async runUntilComplete(opts: ProviderRunOptions): Promise<ProviderRunResult> {
        return {
          ok: true,
          payload: { summary: "all clear", findings: [] },
          turns: 1,
          tokens: { input: 5, output: 7 },
          session: {
            systemPrompt: opts.systemPrompt,
            messages: [
              { role: "user", content: opts.initialInput },
              { role: "assistant", content: "done" },
            ],
          },
        };
      },
    };

    const outcome = await runBureauAgent({
      definition: resolved.definition,
      context: resolved.context,
      input: resolved.buildInput(null),
      args: resolved.args,
      provider,
      maxTurns: 2,
      maxWallclockMs: 5_000,
      mode: "run",
    });

    expect(outcome.result.ok).toBe(true);
    expect(outcome.session.meta.agentName).toBe("daemon-executor");
    expect(outcome.session.meta.args).toEqual(args);
    expect(outcome.session.snapshot.systemPrompt).toContain("docs-command-surface");
    expect(outcome.session.snapshot.systemPrompt).toContain("Audit the changed docs command surface.");

    const sessionsRoot = join(rootDir, ".bureau", "sessions");
    const sessionIds = await readdir(sessionsRoot);
    expect(sessionIds).toHaveLength(1);

    const meta = JSON.parse(
      await readFile(join(sessionsRoot, sessionIds[0]!, "meta.json"), "utf8"),
    );
    const session = JSON.parse(
      await readFile(join(sessionsRoot, sessionIds[0]!, "session.json"), "utf8"),
    );

    expect(meta.agentName).toBe("daemon-executor");
    expect(meta.args).toEqual(args);
    expect(session.version).toBe(1);
    expect(session.messages).toHaveLength(2);
  });

  test("fails clearly when the bureau agent name does not resolve", async () => {
    await expect(
      resolveBureauAgent({
        agentName: "missing-agent",
        args: null,
        root: rootDir,
      }),
    ).rejects.toThrow("unknown bureau agent: missing-agent");
  });
});

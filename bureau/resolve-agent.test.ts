import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

    expect(plan.initialInput).toContain("\"daemonName\": \"docs-command-surface\"");
    expect(plan.initialInput).toContain("\"relevantFiles\"");
    expect(plan.initialInput).toContain("User request:\nhi from operator");
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

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createDaemonExecutorAgentInstance } from "./agent";

let rootDir: string;

beforeEach(async () => {
  rootDir = await mkdtemp(join(tmpdir(), "bureau-daemon-instance-"));
});

afterEach(async () => {
  await rm(rootDir, { recursive: true, force: true });
});

describe("createDaemonExecutorAgentInstance", () => {
  test("returns a first-class agent instance that builds a runnable daemon plan", async () => {
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

    const agent = createDaemonExecutorAgentInstance(
      {
        daemonName: "docs-command-surface",
        relevantFiles: ["apps/docs/README.md"],
      },
      rootDir,
    );

    expect(agent.name).toBe("daemon-executor");
    expect(agent.args).toEqual({
      daemonName: "docs-command-surface",
      relevantFiles: ["apps/docs/README.md"],
    });

    const plan = await agent.definition.run({
      ...agent.context,
      sessionId: "ses_test",
      input: agent.buildInput("hi from operator"),
    });

    expect(plan.systemPrompt).toContain("docs-command-surface");
    expect(plan.initialInput).toContain("apps/docs/README.md");
    expect(plan.initialInput).toContain("User request:\nhi from operator");
    expect(plan.cwd).toBe(join(rootDir, "apps", "docs"));
  });
});

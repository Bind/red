import { describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { BashRuntimeService } from "../service/runtime";
import { FilesystemRunStore } from "../store/filesystem-run-store";
import type { BashRuntimeConfig } from "../util/types";
import { makeTempDir } from "./helpers/tmp";

async function makeRuntime() {
  const dataDir = await makeTempDir("bash-runtime-lab-");
  const config: BashRuntimeConfig = {
    mode: "dev",
    host: "127.0.0.1",
    port: 4093,
    dataDir,
    runsDir: `${dataDir}/runs`,
    workspacesDir: `${dataDir}/workspaces`,
  };

  return {
    config,
    runtime: new BashRuntimeService(config, new FilesystemRunStore(config.runsDir)),
  };
}

describe("BashRuntimeService", () => {
  test("journals command execution with filesystem mutations", async () => {
    const { runtime } = await makeRuntime();
    const script = ["echo first > note.txt", "cat note.txt", "printf 'second\\n' >> note.txt"].join(
      "\n",
    );

    const result = await runtime.execute({
      runId: "demo",
      script,
      env: {},
    });

    expect(result.status).toBe("completed");
    expect(result.commandCount).toBe(3);
    expect(result.stdout).toContain("first");

    const afterEvents = result.journal.filter((event) => event.phase === "after");
    expect(afterEvents).toHaveLength(3);
    expect(afterEvents[0]?.commandText).toBe("echo first >note.txt");
    expect(afterEvents[0]?.fileMutations?.[0]?.path).toBe("note.txt");
    expect(afterEvents[2]?.fileMutations?.[0]?.kind).toBe("updated");
  });

  test("supports external binaries inside pipelines", async () => {
    const { runtime } = await makeRuntime();
    const result = await runtime.execute({
      runId: "pipeline-demo",
      script: "printf 'abc' | wc -c\n",
      env: {},
    });

    expect(result.status).toBe("completed");
    expect(result.stdout.trim()).toBe("3");
    expect(result.commandCount).toBe(2);
  });

  test("distinguishes repeated visits to the same command node", async () => {
    const { runtime } = await makeRuntime();
    const script = ["for item in a b; do", '  echo "$item" >> loop.txt', "done"].join("\n");

    const result = await runtime.execute({
      runId: "loop-demo",
      script,
      env: {},
    });

    const afterEvents = result.journal.filter(
      (event) => event.phase === "after" && event.commandText.includes("echo"),
    );

    expect(afterEvents).toHaveLength(2);
    expect(afterEvents.map((event) => event.visit)).toEqual([1, 2]);
  });

  test("persists the transformed script and command metadata", async () => {
    const { runtime } = await makeRuntime();
    await runtime.execute({
      runId: "inspect-demo",
      script: "echo hello\n",
      env: {},
    });

    const run = await runtime.getRun("inspect-demo");
    expect(run?.transformedScript).toContain("__redc_before");
    expect(run?.commandNodes["script.stmt0.pipe0.cmd0"]?.commandName).toBe("echo");
  });

  test("replays prior command visits on an identical rerun", async () => {
    const { runtime, config } = await makeRuntime();
    const workspaceDir = join(config.workspacesDir, "replay-demo");
    await mkdir(workspaceDir, { recursive: true });
    await Bun.write(join(workspaceDir, "replay.txt"), "cached\n");
    const script = "cat replay.txt";

    const first = await runtime.execute({
      runId: "replay-demo",
      script,
      env: {},
    });
    const second = await runtime.execute({
      runId: "replay-demo",
      script,
      env: {},
    });

    expect(first.status).toBe("completed");
    expect(second.status).toBe("completed");

    const secondAfter = second.journal.filter((event) => event.phase === "after");
    expect(secondAfter).toHaveLength(1);
    expect(secondAfter.every((event) => event.cached)).toBe(true);
    expect(second.stdout).toBe(first.stdout);
    expect(second.stderr).toBe(first.stderr);

    const run = await runtime.getRun("replay-demo");
    expect(run?.workspaceDir).toContain("replay-demo");
  });

  test("breaks cache when manual dependency hashes change", async () => {
    const { runtime } = await makeRuntime();
    const script = ["echo dep > dep.txt", "cat dep.txt"].join("\n");

    await runtime.execute({
      runId: "dependency-demo",
      script,
      env: {},
      dependencyHashes: {
        upstream: "hash-a",
      },
    });

    const second = await runtime.execute({
      runId: "dependency-demo",
      script,
      env: {},
      dependencyHashes: {
        upstream: "hash-b",
      },
    });

    const afterEvents = second.journal.filter((event) => event.phase === "after");
    expect(afterEvents).toHaveLength(2);
    expect(afterEvents.some((event) => !event.cached)).toBe(true);
  });
});

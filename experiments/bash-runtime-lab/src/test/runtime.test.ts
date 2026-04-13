import { describe, expect, test } from "bun:test";
import { FilesystemRunStore } from "../store/filesystem-run-store";
import { BashRuntimeService } from "../service/runtime";
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
  test("replays completed durable chunks on rerun", async () => {
    const { runtime } = await makeRuntime();
    const script = [
      "echo start > marker.txt",
      "# @durable build",
      "count=$(cat marker.txt | wc -l | tr -d ' ')",
      "printf '%s' \"$count\" | durable_set line_count",
      "printf 'build:%s\\n' \"$(durable_get line_count)\"",
      "# @enddurable",
      "# @durable publish",
      "printf 'publish:%s\\n' \"$(durable_get line_count)\"",
      "# @enddurable",
    ].join("\n");

    const first = await runtime.execute({
      runId: "demo",
      script,
      env: {},
    });

    expect(first.status).toBe("completed");
    expect(first.executions.map((entry) => entry.cached)).toEqual([false, false, false]);

    const second = await runtime.execute({
      runId: "demo",
      script,
      env: {},
    });

    expect(second.status).toBe("completed");
    expect(second.executions.map((entry) => entry.cached)).toEqual([false, true, true]);
    expect(second.executions[1]?.stdout).toBe(first.executions[1]?.stdout);
  });

  test("supports interruption after a durable chunk and resumes later", async () => {
    const { runtime } = await makeRuntime();
    const script = [
      "# @durable one",
      "printf '%s' 'ready' | durable_set artifact",
      "printf 'one\\n'",
      "# @enddurable",
      "# @durable two",
      "printf 'two:%s\\n' \"$(durable_get artifact)\"",
      "# @enddurable",
    ].join("\n");

    const interrupted = await runtime.execute({
      runId: "resume-demo",
      script,
      env: {},
      interruptAfterChunk: "one",
    });

    expect(interrupted.status).toBe("interrupted");
    expect(interrupted.executions).toHaveLength(1);
    expect(interrupted.executions[0]?.stdout).toContain("one");

    const resumed = await runtime.execute({
      runId: "resume-demo",
      script,
      env: {},
    });

    expect(resumed.status).toBe("completed");
    expect(resumed.executions.map((entry) => entry.cached)).toEqual([true, false]);
    expect(resumed.executions[1]?.stdout).toContain("two:ready");
  });
});

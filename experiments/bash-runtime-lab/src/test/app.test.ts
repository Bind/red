import { describe, expect, test } from "bun:test";
import { createApp } from "../service/app";
import { BashRuntimeService } from "../service/runtime";
import { FilesystemRunStore } from "../store/filesystem-run-store";
import type { BashRuntimeConfig } from "../util/types";
import { makeTempDir } from "./helpers/tmp";

async function makeHarness() {
  const dataDir = await makeTempDir("bash-runtime-app-");
  const config: BashRuntimeConfig = {
    mode: "dev",
    host: "127.0.0.1",
    port: 4093,
    dataDir,
    runsDir: `${dataDir}/runs`,
    workspacesDir: `${dataDir}/workspaces`,
  };
  const runtime = new BashRuntimeService(config, new FilesystemRunStore(config.runsDir));
  return {
    config,
    app: createApp(config, runtime),
    runtime,
  };
}

describe("createApp", () => {
  test("reports health", async () => {
    const { app, config } = await makeHarness();
    const response = await app.request("/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      mode: "dev",
      dataDir: config.dataDir,
    });
  });

  test("executes a script and exposes run state", async () => {
    const { app } = await makeHarness();
    const body = {
      runId: "app-demo",
      script: [
        "# @durable build",
        "printf '%s' 'built' | durable_set artifact",
        "printf 'build\\n'",
        "# @enddurable",
      ].join("\n"),
    };

    const executeResponse = await app.request("/runs/execute", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    expect(executeResponse.status).toBe(200);
    const executeJson = (await executeResponse.json()) as {
      result: { status: string; executions: Array<{ segmentId: string }> };
    };
    expect(executeJson.result.status).toBe("completed");
    expect(executeJson.result.executions).toHaveLength(1);
    expect(executeJson.result.executions[0]?.segmentId).toBe("build");

    const runResponse = await app.request("/runs/app-demo");
    expect(runResponse.status).toBe(200);
    const runJson = (await runResponse.json()) as {
      run: { kv: Record<string, string> };
    };
    expect(runJson.run.kv).toEqual({ artifact: "built" });
  });

  test("validates execute requests", async () => {
    const { app } = await makeHarness();
    const response = await app.request("/runs/execute", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ runId: "", script: "" }),
    });

    expect(response.status).toBe(400);
  });
});

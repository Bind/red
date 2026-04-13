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
      script: ["echo first > note.txt", "cat note.txt"].join("\n"),
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
      result: { status: string; commandCount: number; stdout: string };
    };
    expect(executeJson.result.status).toBe("completed");
    expect(executeJson.result.commandCount).toBe(2);
    expect(executeJson.result.stdout).toContain("first");

    const runResponse = await app.request("/runs/app-demo");
    expect(runResponse.status).toBe(200);
    const runJson = (await runResponse.json()) as {
      run: {
        journal: Array<{ phase: string }>;
        commandNodes: Record<string, { commandName: string }>;
      };
    };
    expect(runJson.run.journal.some((event) => event.phase === "after")).toBe(true);
    expect(runJson.run.commandNodes["script.stmt0.pipe0.cmd0"]?.commandName).toBe("echo");
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

import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../util/config";

describe("loadConfig", () => {
  test("loads dev defaults into a temp data dir", () => {
    const root = mkdtempSync(join(tmpdir(), "ci-runner-lab-config-"));

    const config = loadConfig({
      CI_RUNNER_LAB_DATA_DIR: join(root, "data"),
    });

    expect(config.mode).toBe("dev");
    expect(config.port).toBe(4091);
    expect(config.maxConcurrentRuns).toBe(2);
    expect(config.runsFile.endsWith("runs.json")).toBe(true);
  });

  test("requires explicit compose env", () => {
    expect(() =>
      loadConfig({
        CI_RUNNER_LAB_MODE: "compose",
        CI_RUNNER_LAB_HOST: "0.0.0.0",
        CI_RUNNER_LAB_PORT: "4091",
        CI_RUNNER_LAB_DATA_DIR: "/data",
        CI_RUNNER_LAB_WORK_DIR: "/data/work",
      }),
    ).toThrow("CI_RUNNER_LAB_RUNS_FILE is required");
  });
});

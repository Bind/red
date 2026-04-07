import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../util/config";

describe("loadConfig", () => {
  test("loads dev config from a repos file", () => {
    const root = mkdtempSync(join(tmpdir(), "git-mirror-canary-config-"));
    const reposPath = join(root, "repos.json");
    writeFileSync(
      reposPath,
      JSON.stringify([
        {
          id: "github/git",
          sourceUrl: "https://github.com/git/git.git",
          targetUrl: "https://git.internal/redc/git.git",
          trackedRef: "refs/heads/master",
        },
      ]),
    );

    const config = loadConfig({
      GIT_MIRROR_CANARY_REPOS_FILE: reposPath,
      GIT_MIRROR_CANARY_DATA_DIR: join(root, "data"),
    });

    expect(config.mode).toBe("dev");
    expect(config.repos).toHaveLength(1);
    expect(config.repos[0]?.trackedRef).toBe("refs/heads/master");
  });

  test("requires explicit compose env", () => {
    expect(() =>
      loadConfig({
        GIT_MIRROR_CANARY_MODE: "compose",
        GIT_MIRROR_CANARY_HOST: "0.0.0.0",
        GIT_MIRROR_CANARY_PORT: "4080",
        GIT_MIRROR_CANARY_POLL_INTERVAL_MS: "1000",
        GIT_MIRROR_CANARY_DATA_DIR: "/data",
        GIT_MIRROR_CANARY_CACHE_DIR: "/data/cache",
        GIT_MIRROR_CANARY_STATE_DB_PATH: "/data/state.sqlite",
      }),
    ).toThrow(
      "GIT_MIRROR_CANARY_REPOS_FILE or GIT_MIRROR_CANARY_REPOS_JSON is required in compose mode",
    );
  });
});

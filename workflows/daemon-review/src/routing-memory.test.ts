import { describe, expect, test } from "bun:test";
import type { DaemonMemorySnapshot } from "../../../pkg/daemons/src/index";
import { buildDaemonRoutingMemory } from "./routing-memory";

describe("buildDaemonRoutingMemory", () => {
  test("projects scope-relative memory paths into repo-relative routing paths", () => {
    const snapshot = {
      record: {
        version: 3,
        daemonContractVersion: 1,
        daemon: "compose-contract",
        scopeRoot: "/repo/infra",
        repoRoot: "/repo",
        repoId: "Bind/red",
        commit: "abc",
        baseCommit: null,
        updatedAt: "2026-01-01T00:00:00.000Z",
        tracked: {
          preview_gateway_contract: {
            subject: "preview_gateway_contract",
            fingerprint: "abc",
            fact: {},
            depends_on: ["preview/deploy.sh", "platform/gateway/envoy.yaml.template"],
            checked_at: "2026-01-01T00:00:00.000Z",
            source_run_id: "run_a",
          },
        },
        lastRun: {
          summary: "ok",
          findings: [],
          checkedFiles: [
            {
              path: "preview/seed.sh",
              fingerprint: "def",
              size: 12,
              mtimeMs: 1,
            },
          ],
          fileInventory: [],
        },
      },
      currentCommit: "def",
      unchangedFiles: [],
      changedFiles: [],
      missingFiles: [],
      newFiles: [],
      changedScopeFiles: [],
      missingScopeFiles: [],
      staleTrackedSubjects: ["preview_gateway_contract"],
    } satisfies DaemonMemorySnapshot;

    const memory = buildDaemonRoutingMemory(snapshot, "infra");

    expect(memory.checkedFiles).toEqual(["infra/preview/seed.sh"]);
    expect(memory.dependencyFiles).toEqual([
      "infra/platform/gateway/envoy.yaml.template",
      "infra/preview/deploy.sh",
    ]);
    expect(memory.trackedSubjects).toEqual(["preview_gateway_contract"]);
    expect(memory.staleTrackedSubjects).toEqual(["preview_gateway_contract"]);
  });
});

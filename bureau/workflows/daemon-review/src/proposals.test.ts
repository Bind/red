import { describe, expect, test } from "bun:test";
import { blockingOutcomes } from "./proposals";
import type { DaemonOutcome } from "./types";

function makeOutcome(overrides: Partial<DaemonOutcome>): DaemonOutcome {
  return {
    name: "environment-boundaries",
    ok: true,
    runId: "run_test",
    summary: "summary",
    findings: [],
    wideEvents: [],
    turns: 1,
    tokens: { input: 0, output: 0 },
    viewedFiles: [],
    changedFiles: [],
    initialMemory: null,
    diff: "",
    ...overrides,
  };
}

describe("blockingOutcomes", () => {
  test("does not block on persistent debt when the daemon scope was unchanged", () => {
    const outcomes = [
      makeOutcome({
        findings: [{ invariant: "stale_path", status: "violation_persists", note: "old debt" }],
        initialMemory: {
          snapshotCommit: "abc",
          currentCommit: "def",
          previousSummary: "",
          trackedSubjects: [],
          staleTrackedSubjects: [],
          checkedFiles: [],
          changedFiles: [],
          newFiles: [],
          missingFiles: [],
          changedScopeFiles: [],
        },
      }),
    ];

    expect(blockingOutcomes(outcomes)).toEqual([]);
  });

  test("blocks on persistent violations when the daemon scope changed", () => {
    const outcome = makeOutcome({
      findings: [{ invariant: "stale_path", status: "violation_persists", note: "still broken" }],
      initialMemory: {
        snapshotCommit: "abc",
        currentCommit: "def",
        previousSummary: "",
        trackedSubjects: [],
        staleTrackedSubjects: [],
        checkedFiles: [],
        changedFiles: [],
        newFiles: [],
        missingFiles: [],
        changedScopeFiles: ["infra/compose-contract.daemon.md"],
      },
    });

    expect(blockingOutcomes([outcome])).toEqual([outcome]);
  });

  test("still blocks infra failures regardless of scope change", () => {
    const outcome = makeOutcome({
      ok: false,
      message: "daemon crashed",
      initialMemory: {
        snapshotCommit: "abc",
        currentCommit: "def",
        previousSummary: "",
        trackedSubjects: [],
        staleTrackedSubjects: [],
        checkedFiles: [],
        changedFiles: [],
        newFiles: [],
        missingFiles: [],
        changedScopeFiles: [],
      },
    });

    expect(blockingOutcomes([outcome])).toEqual([outcome]);
  });
});

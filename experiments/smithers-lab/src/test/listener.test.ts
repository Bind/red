import { describe, expect, test } from "bun:test";

import { pollWideEvent500Candidates } from "../service/wide-event-500-autofix/listener";
import type { AppConfig } from "../util/config";

const config: AppConfig = {
  mode: "dev",
  hostname: "127.0.0.1",
  port: 4090,
  dbPath: "/tmp/smithers-lab.sqlite",
  dataDir: "/tmp",
  openaiModel: "gpt-5-mini",
  allowNetwork: false,
};

describe("pollWideEvent500Candidates", () => {
  test("queries rollups and only starts workflows for accepted candidates", async () => {
    const result = await pollWideEvent500Candidates(
      config,
      {
        async listTerminalCandidates() {
          return [
            {
              requestId: "req-low",
              isRootRequest: true,
              service: "api",
              route: "/rpc/app/hosted-repo",
              method: "GET",
              statusCode: 500,
              requestState: "error",
              rolledUpAt: "2026-04-08T12:00:00Z",
              rollupReason: "terminal_event",
              fingerprint: "api:/rpc/app/hosted-repo:500:typeerror",
              occurrenceCount: 1,
              windowMinutes: 15,
              severity: "high",
            },
            {
              requestId: "req-high",
              isRootRequest: true,
              service: "api",
              route: "/rpc/app/hosted-repo",
              method: "GET",
              statusCode: 500,
              requestState: "error",
              rolledUpAt: "2026-04-08T12:01:00Z",
              rollupReason: "terminal_event",
              fingerprint: "api:/rpc/app/hosted-repo:500:typeerror",
              occurrenceCount: 3,
              windowMinutes: 15,
              severity: "high",
              repo: "apps/api",
            },
          ];
        },
      },
      {
        since: "2026-04-08T11:45:00Z",
        services: ["api"],
        routes: [],
        requireRootRequest: true,
        requestStates: ["completed"],
        finalOutcomes: ["error"],
        minStatusCode: 500,
        requireTerminal: true,
        limit: 20,
      },
      async () => ({
        runId: "run_diag_2",
        status: "running",
      }),
    );

    expect(result.skipped).toEqual([
      {
        requestId: "req-low",
        fingerprint: "api:/rpc/app/hosted-repo:500:typeerror",
        reason: "Fingerprint has not met the recurrence or severity threshold",
      },
    ]);
    expect(result.accepted).toEqual([
      {
        requestId: "req-high",
        fingerprint: "api:/rpc/app/hosted-repo:500:typeerror",
        reason: "Recurring fingerprint met automatic diagnosis threshold",
        result: {
          runId: "run_diag_2",
          status: "running",
        },
      },
    ]);
  });
});

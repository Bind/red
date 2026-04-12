import { describe, expect, test } from "bun:test";

import { createApp } from "../service/app";
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

describe("createApp", () => {
  test("reports health", async () => {
    const app = createApp(config);
    const response = await app.request("/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      mode: "dev",
      dbPath: "/tmp/smithers-lab.sqlite",
      model: "gpt-5-mini",
    });
  });

  test("validates workflow request bodies", async () => {
    const app = createApp(config);
    const response = await app.request("/workflows/research-brief", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ topic: "" }),
    });

    expect(response.status).toBe(400);
  });

  test("runs the workflow through injected dependencies", async () => {
    const app = createApp(config, {
      runResearchBrief: async () => ({
        runId: "run_123",
        status: "finished",
        output: [{ title: "Smithers Lab", recommendation: "Keep going", nextSteps: ["Run it"] }],
      }),
    });

    const response = await app.request("/workflows/research-brief", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        topic: "smithers.sh",
        audience: "engineering",
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      result: {
        runId: "run_123",
        status: "finished",
        output: [{ title: "Smithers Lab", recommendation: "Keep going", nextSteps: ["Run it"] }],
      },
    });
  });

  test("ignores wide-event triggers below the diagnosis threshold", async () => {
    const app = createApp(config);
    const response = await app.request("/triggers/wide-events/500", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        requestId: "req_123",
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
      }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      ok: true,
      accepted: false,
      reason: "Fingerprint has not met the recurrence or severity threshold",
    });
  });

  test("accepts wide-event triggers and starts the diagnosis workflow", async () => {
    const app = createApp(config, {
      runWideEvent500AutofixWorkflow: async () => ({
        runId: "run_diag_1",
        status: "running",
      }),
    });
    const response = await app.request("/triggers/wide-events/500", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        requestId: "req_500_1",
        isRootRequest: true,
        service: "api",
        route: "/rpc/app/hosted-repo",
        method: "GET",
        statusCode: 500,
        requestState: "error",
        rolledUpAt: "2026-04-08T12:00:00Z",
        rollupReason: "terminal_event",
        fingerprint: "api:/rpc/app/hosted-repo:500:typeerror",
        occurrenceCount: 3,
        windowMinutes: 15,
        severity: "high",
        repo: "apps/ctl",
      }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      ok: true,
      accepted: true,
      reason: "Recurring fingerprint met automatic diagnosis threshold",
      result: {
        runId: "run_diag_1",
        status: "running",
      },
    });
  });

  test("polls queried wide-event rollups and starts workflows for matching terminal failures", async () => {
    const app = createApp(config, {
      wideEventRollupReader: {
        async listTerminalCandidates() {
          return [
            {
              requestId: "req-polled-1",
              isRootRequest: true,
              service: "api",
              route: "/rpc/app/hosted-repo",
              method: "GET",
              statusCode: 500,
              requestState: "error",
              rolledUpAt: "2026-04-08T12:00:00Z",
              rollupReason: "terminal_event",
              fingerprint: "api:/rpc/app/hosted-repo:500:typeerror",
              occurrenceCount: 4,
              windowMinutes: 15,
              severity: "high",
              repo: "apps/ctl",
            },
          ];
        },
      },
      runWideEvent500AutofixWorkflow: async () => ({
        runId: "run_diag_polled",
        status: "running",
      }),
    });
    const response = await app.request("/triggers/wide-events/poll", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        since: "2026-04-08T11:45:00Z",
        services: ["api"],
        finalOutcomes: ["error"],
        minStatusCode: 500,
        requireTerminal: true,
        limit: 10,
      }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      ok: true,
      query: {
        since: "2026-04-08T11:45:00Z",
        services: ["api"],
        routes: [],
        requireRootRequest: true,
        requestStates: ["completed"],
        finalOutcomes: ["error"],
        minStatusCode: 500,
        requireTerminal: true,
        limit: 10,
      },
      accepted: [
        {
          requestId: "req-polled-1",
          fingerprint: "api:/rpc/app/hosted-repo:500:typeerror",
          reason: "Recurring fingerprint met automatic diagnosis threshold",
          result: {
            runId: "run_diag_polled",
            status: "running",
          },
        },
      ],
      skipped: [],
    });
  });
});

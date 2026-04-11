import { Hono } from "hono";

import type { AppConfig } from "../util/config";
import {
  runResearchBriefRequestSchema,
  type SmithersRunResponse,
  wideEvent500AutofixTriggerSchema,
  wideEventTerminalQuerySchema,
} from "../util/types";
import { runResearchBrief } from "./run-research-brief";
import {
  pollWideEvent500Candidates,
  type WideEventRollupReader,
} from "./wide-event-500-autofix/listener";
import { runWideEvent500AutofixWorkflow } from "./wide-event-500-autofix/run-workflow";
import { evaluateWideEvent500Trigger } from "./wide-event-500-autofix/trigger-gate";

export function createApp(
  config: AppConfig,
  deps: {
    runResearchBrief?: (
      config: AppConfig,
      input: {
        topic: string;
        audience: string;
      },
    ) => Promise<SmithersRunResponse>;
    runWideEvent500AutofixWorkflow?: (
      config: AppConfig,
      input: {
        requestId: string;
        parentRequestId?: string;
        isRootRequest: boolean;
        service: string;
        route: string;
        method: string;
        statusCode: number;
        requestState: "completed" | "error" | "incomplete";
        rolledUpAt: string;
        rollupReason: "terminal_event" | "timeout";
        errorMessage?: string;
        fingerprint: string;
        occurrenceCount: number;
        windowMinutes: number;
        severity: "low" | "medium" | "high" | "critical";
        repo?: string;
        branch?: string;
        changeId?: string;
        runId?: string;
        actor?: string;
      },
    ) => Promise<SmithersRunResponse>;
    wideEventRollupReader?: WideEventRollupReader;
  } = {},
) {
  const researchBriefRunner = deps.runResearchBrief ?? runResearchBrief;
  const wideEvent500Runner = deps.runWideEvent500AutofixWorkflow ?? runWideEvent500AutofixWorkflow;
  const wideEventRollupReader = deps.wideEventRollupReader;
  const app = new Hono();

  app.get("/health", (c) =>
    c.json({
      ok: true,
      mode: config.mode,
      dbPath: config.dbPath,
      model: config.openaiModel,
    }),
  );

  app.post("/workflows/research-brief", async (c) => {
    const payload = await c.req.json().catch(() => null);
    const parsed = runResearchBriefRequestSchema.safeParse(payload);

    if (!parsed.success) {
      return c.json(
        {
          ok: false,
          error: "Invalid request body",
          issues: parsed.error.issues,
        },
        400,
      );
    }

    const result = await researchBriefRunner(config, parsed.data);
    const statusCode = result.status === "failed" ? 500 : 200;

    return c.json(
      {
        ok: result.status === "finished",
        result,
      },
      statusCode,
    );
  });

  app.post("/triggers/wide-events/500", async (c) => {
    const payload = await c.req.json().catch(() => null);
    const parsed = wideEvent500AutofixTriggerSchema.safeParse(payload);

    if (!parsed.success) {
      return c.json(
        {
          ok: false,
          error: "Invalid request body",
          issues: parsed.error.issues,
        },
        400,
      );
    }

    const gate = evaluateWideEvent500Trigger(parsed.data);
    if (!gate.accepted) {
      return c.json(
        {
          ok: true,
          accepted: false,
          reason: gate.reason,
        },
        202,
      );
    }

    const result = await wideEvent500Runner(config, parsed.data);
    const statusCode = result.status === "failed" ? 500 : 202;

    return c.json(
      {
        ok: result.status !== "failed",
        accepted: true,
        reason: gate.reason,
        result,
      },
      statusCode,
    );
  });

  app.post("/triggers/wide-events/poll", async (c) => {
    if (!wideEventRollupReader) {
      return c.json(
        {
          ok: false,
          error: "wide-event rollup reader is not configured",
        },
        501,
      );
    }

    const payload = await c.req.json().catch(() => null);
    const parsed = wideEventTerminalQuerySchema.safeParse(payload);

    if (!parsed.success) {
      return c.json(
        {
          ok: false,
          error: "Invalid request body",
          issues: parsed.error.issues,
        },
        400,
      );
    }

    const result = await pollWideEvent500Candidates(
      config,
      wideEventRollupReader,
      parsed.data,
      wideEvent500Runner,
    );

    return c.json(
      {
        ok: true,
        query: parsed.data,
        accepted: result.accepted,
        skipped: result.skipped,
      },
      202,
    );
  });

  return app;
}

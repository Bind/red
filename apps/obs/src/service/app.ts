import { buildHealth, statusHttpCode } from "@red/health";
import type { DaemonMemoryRecord, DaemonRunIndexEntry, DaemonRunRecord } from "@red/daemons";
import { Hono, createHttpLogger } from "@red/server";
import type { WideCollectorBatchResponse } from "./collector-contract";
import {
	acceptCollectorBatch,
	type CollectorDependencies,
	flushExpiredCollectorRequests,
} from "./collector-service";

export interface CollectorApp extends Hono {
	flushExpired(now?: Date): Promise<number>;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function renderDaemonDebugPage(
	daemon: string,
	memory: DaemonMemoryRecord | null,
	runs: DaemonRunIndexEntry[],
	latestRun: DaemonRunRecord | null,
): string {
	const trackedRows = Object.values(memory?.tracked ?? {})
		.map((entry) => entry as DaemonMemoryRecord["tracked"][string])
		.slice(0, 25)
		.map(
			(entry) =>
				`<tr><td><code>${escapeHtml(entry.subject)}</code></td><td>${escapeHtml(entry.depends_on.join(", "))}</td><td>${escapeHtml(entry.checked_at)}</td></tr>`,
		)
		.join("");
	const runRows = runs
		.map(
			(run) =>
				`<tr><td><a href="/v1/daemons/${encodeURIComponent(daemon)}/runs/${encodeURIComponent(run.runId)}">${escapeHtml(run.runId)}</a></td><td>${escapeHtml(run.status)}</td><td>${escapeHtml(run.startedAt)}</td><td>${escapeHtml(run.finishedAt)}</td><td>${escapeHtml(run.summary ?? run.reason ?? "—")}</td></tr>`,
		)
		.join("");

	return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Daemon Debug: ${escapeHtml(daemon)}</title>
    <style>
      body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #0b0d10; color: #e5e7eb; margin: 0; padding: 24px; }
      h1, h2 { margin: 0 0 12px; }
      section { margin: 0 0 24px; padding: 16px; border: 1px solid #29303a; border-radius: 8px; background: #11161c; }
      table { width: 100%; border-collapse: collapse; }
      th, td { text-align: left; padding: 8px; border-top: 1px solid #29303a; vertical-align: top; }
      th { color: #93a1b2; font-weight: 600; }
      code { color: #fca5a5; }
      a { color: #93c5fd; }
      .muted { color: #93a1b2; }
      pre { overflow: auto; white-space: pre-wrap; background: #0b0d10; padding: 12px; border-radius: 6px; }
    </style>
  </head>
  <body>
    <h1>Daemon Debug: ${escapeHtml(daemon)}</h1>
    <p class="muted">Quick view of latest memory and recent persisted runs.</p>
    <section>
      <h2>Latest Memory</h2>
      ${
				memory
					? `<p>commit: <code>${escapeHtml(memory.commit ?? "unknown")}</code></p>
         <p>updated: <code>${escapeHtml(memory.updatedAt)}</code></p>
         <p>summary: ${escapeHtml(memory.lastRun.summary)}</p>
         <p>checked files: ${memory.lastRun.checkedFiles.length} · tracked subjects: ${Object.keys(memory.tracked).length}</p>`
					: `<p class="muted">No daemon memory found yet.</p>`
			}
      ${
				trackedRows
					? `<table><thead><tr><th>Subject</th><th>Depends On</th><th>Checked At</th></tr></thead><tbody>${trackedRows}</tbody></table>`
					: ""
			}
    </section>
    <section>
      <h2>Recent Runs</h2>
      ${
				runRows
					? `<table><thead><tr><th>Run</th><th>Status</th><th>Started</th><th>Finished</th><th>Result</th></tr></thead><tbody>${runRows}</tbody></table>`
					: `<p class="muted">No persisted runs found yet.</p>`
			}
    </section>
    <section>
      <h2>Latest Kickoff Prompt</h2>
      ${
				latestRun
					? `<p>run: <code>${escapeHtml(latestRun.runId)}</code></p>
         <p class="muted">System prompt rendered by the runner, plus the initial input passed to the provider.</p>
         <h3>System Prompt</h3>
         <pre>${escapeHtml(latestRun.systemPrompt ?? "(not recorded for this run)")}</pre>
         <h3>Initial Input</h3>
         <pre>${escapeHtml(latestRun.input ?? "(none)")}</pre>`
					: `<p class="muted">No persisted run found yet.</p>`
			}
    </section>
  </body>
</html>`;
}

export function createApp(deps: CollectorDependencies): CollectorApp {
	const app = new Hono();
	app.use("*", createHttpLogger({ service: "obs", app: "red" }));

	app.get("/health", (c) => {
		const health = buildHealth({ service: "obs" });
		return c.json(health, statusHttpCode(health.status));
	});

	const query = deps.rollupQuery;

	app.get("/v1/rollups", async (c) => {
		if (!query) {
			return c.json({ error: "rollup query engine not configured" }, 501);
		}
		const service = c.req.query("service") ?? undefined;
		const outcomeRaw = c.req.query("outcome");
		const outcome =
			outcomeRaw === "ok" || outcomeRaw === "error" || outcomeRaw === "unknown"
				? outcomeRaw
				: undefined;
		const sinceRaw = c.req.query("since");
		const since =
			sinceRaw && !Number.isNaN(Date.parse(sinceRaw))
				? new Date(sinceRaw)
				: undefined;
		const limitRaw = c.req.query("limit");
		const limit = limitRaw
			? Math.min(Math.max(Number.parseInt(limitRaw, 10), 1), 500)
			: 100;
		const records = await query.listRollups({
			service,
			outcome,
			since,
			limit,
		});
		return c.json({ rollups: records, count: records.length });
	});

	app.get("/v1/rollups/stats", async (c) => {
		if (!query?.aggregateRollups) {
			return c.json({ error: "rollup query engine not configured" }, 501);
		}
		const groupByRaw = c.req.query("groupBy") ?? "entry_service";
		const allowed = [
			"entry_service",
			"route",
			"final_outcome",
			"error_name",
		] as const;
		if (!(allowed as readonly string[]).includes(groupByRaw)) {
			return c.json(
				{ error: `groupBy must be one of ${allowed.join(", ")}` },
				400,
			);
		}
		const sinceRaw = c.req.query("since");
		const since =
			sinceRaw && !Number.isNaN(Date.parse(sinceRaw))
				? new Date(sinceRaw)
				: undefined;
		const limitRaw = c.req.query("limit");
		const limit = limitRaw
			? Math.min(Math.max(Number.parseInt(limitRaw, 10), 1), 500)
			: 50;
		const rows = await query.aggregateRollups({
			groupBy: groupByRaw as (typeof allowed)[number],
			since,
			limit,
		});
		return c.json({ rows });
	});

	app.get("/v1/rollups/:request_id", async (c) => {
		if (!query) {
			return c.json({ error: "rollup query engine not configured" }, 501);
		}
		const record = await query.getRollup(c.req.param("request_id"));
		if (!record) return c.json({ error: "not found" }, 404);
		return c.json(record);
	});

	app.get("/v1/daemons/:daemon/memory", async (c) => {
		if (!deps.daemonQuery) {
			return c.json({ error: "daemon query engine not configured" }, 501);
		}
		const daemon = c.req.param("daemon");
		const memory = await deps.daemonQuery.getMemory(daemon).catch(() => null);
		if (!memory) return c.json({ error: "not found" }, 404);
		return c.json(memory);
	});

	app.get("/v1/daemons/:daemon/runs", async (c) => {
		if (!deps.daemonQuery) {
			return c.json({ error: "daemon query engine not configured" }, 501);
		}
		const daemon = c.req.param("daemon");
		const runs = await deps.daemonQuery.listRuns(daemon).catch(() => null);
		if (!runs) return c.json({ error: "not found" }, 404);
		return c.json({ runs, count: runs.length });
	});

	app.get("/v1/daemons/:daemon/runs/:run_id", async (c) => {
		if (!deps.daemonQuery) {
			return c.json({ error: "daemon query engine not configured" }, 501);
		}
		const daemon = c.req.param("daemon");
		const run = await deps.daemonQuery
			.getRun(daemon, c.req.param("run_id"))
			.catch(() => null);
		if (!run) return c.json({ error: "not found" }, 404);
		return c.json(run);
	});

	app.get("/v1/daemons/:daemon/debug", async (c) => {
		if (!deps.daemonQuery) {
			return c.html("<p>daemon query engine not configured</p>", 501);
		}
		const daemon = c.req.param("daemon");
		const [memory, runs] = await Promise.all([
			deps.daemonQuery.getMemory(daemon).catch(() => null),
			deps.daemonQuery.listRuns(daemon).catch(() => []),
		]);
		const latestRun = runs[0]
			? await deps.daemonQuery.getRun(daemon, runs[0].runId).catch(() => null)
			: null;
		return c.html(renderDaemonDebugPage(daemon, memory, runs, latestRun));
	});

	app.post("/v1/events", async (c) => {
		const payload = await c.req.json().catch(() => null);
		if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
			return c.json(
				{
					accepted: 0,
					rejected: 0,
					request_ids: [],
					errors: [
						{
							event_id: "batch",
							reason: "request body must be a JSON object",
						},
					],
				} satisfies WideCollectorBatchResponse,
				400,
			);
		}

		const result = await acceptCollectorBatch(payload, deps);
		return c.json(result.body, result.status as 202 | 207 | 400);
	});

	return Object.assign(app, {
		flushExpired(now?: Date) {
			return flushExpiredCollectorRequests(deps, now);
		},
	});
}

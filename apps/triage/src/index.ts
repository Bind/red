import { createApp } from "./app";
import { TriageOrchestrator } from "./orchestrator";
import { InMemoryRunStore } from "./runs/store";
import {
	StubTriageWorkflowRunner,
	type TriageWorkflowRunner,
} from "./workflows/runner";
import { SmithersHttpClient } from "./workflows/smithers-client";
import { SmithersTriageRunner } from "./workflows/smithers-runner";

interface TriageConfig {
	port: number;
	workflowMode: "stub" | "smithers";
	smithersBaseUrl?: string;
	smithersAuthToken?: string;
	smithersDbPath?: string;
	workflowPath?: string;
}

function loadConfig(): TriageConfig {
	const mode = (process.env.TRIAGE_WORKFLOW_MODE ?? "stub").toLowerCase();
	if (mode !== "stub" && mode !== "smithers") {
		throw new Error(
			"TRIAGE_WORKFLOW_MODE must be either 'stub' or 'smithers'",
		);
	}
	return {
		port: Number.parseInt(process.env.TRIAGE_PORT ?? "7000", 10),
		workflowMode: mode as "stub" | "smithers",
		smithersBaseUrl: process.env.TRIAGE_SMITHERS_BASE_URL,
		smithersAuthToken: process.env.SMITHERS_API_KEY,
		smithersDbPath: process.env.TRIAGE_SMITHERS_DB_PATH,
		workflowPath: process.env.TRIAGE_WORKFLOW_PATH,
	};
}

function createRunner(config: TriageConfig): TriageWorkflowRunner {
	if (config.workflowMode === "stub") {
		return new StubTriageWorkflowRunner();
	}
	const { smithersBaseUrl, smithersDbPath, workflowPath } = config;
	if (!smithersBaseUrl || !smithersDbPath || !workflowPath) {
		throw new Error(
			"TRIAGE_WORKFLOW_MODE=smithers requires TRIAGE_SMITHERS_BASE_URL, TRIAGE_SMITHERS_DB_PATH, TRIAGE_WORKFLOW_PATH",
		);
	}
	const client = new SmithersHttpClient({
		baseUrl: smithersBaseUrl,
		authToken: config.smithersAuthToken,
		smithersDbPath,
	});
	return new SmithersTriageRunner({ client, workflowPath });
}

const config = loadConfig();
const store = new InMemoryRunStore();
const runner = createRunner(config);
const orchestrator = new TriageOrchestrator({
	store,
	runner,
	onRunUpdate: (run) => {
		console.log(`triage run ${run.id} → ${run.status}`);
	},
});

const app = createApp({ store, orchestrator });

console.log(
	`triage service listening on http://0.0.0.0:${config.port} (workflow=${config.workflowMode})`,
);

Bun.serve({ port: config.port, fetch: app.fetch });

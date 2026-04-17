import { createApp } from "./app";
import { TriageOrchestrator } from "./orchestrator";
import { InMemoryRunStore } from "./runs/store";
import { StubTriageWorkflowRunner } from "./workflows/runner";
import { SmithersTriageRunner } from "./workflows/smithers-runner";
import type { TriageWorkflowRunner } from "./workflows/runner";

interface TriageConfig {
	port: number;
	workflowMode: "stub" | "smithers";
	smithersCommand: string[];
	investigateWorkflowPath?: string;
	proposeWorkflowPath?: string;
	smithersDbPath?: string;
}

function parseCommand(raw: string | undefined, fallback: string[]): string[] {
	if (!raw || raw.trim().length === 0) return fallback;
	return raw
		.trim()
		.split(/\s+/)
		.filter((part) => part.length > 0);
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
		smithersCommand: parseCommand(process.env.TRIAGE_SMITHERS_CMD, [
			"bunx",
			"smithers-orchestrator",
		]),
		investigateWorkflowPath: process.env.TRIAGE_INVESTIGATE_WORKFLOW,
		proposeWorkflowPath: process.env.TRIAGE_PROPOSE_WORKFLOW,
		smithersDbPath: process.env.TRIAGE_SMITHERS_DB_PATH,
	};
}

function createRunner(config: TriageConfig): TriageWorkflowRunner {
	if (config.workflowMode === "stub") {
		return new StubTriageWorkflowRunner();
	}
	const { investigateWorkflowPath, proposeWorkflowPath, smithersDbPath } =
		config;
	if (!investigateWorkflowPath || !proposeWorkflowPath || !smithersDbPath) {
		throw new Error(
			"TRIAGE_WORKFLOW_MODE=smithers requires TRIAGE_INVESTIGATE_WORKFLOW, TRIAGE_PROPOSE_WORKFLOW, TRIAGE_SMITHERS_DB_PATH",
		);
	}
	return new SmithersTriageRunner({
		smithersCommand: config.smithersCommand,
		investigateWorkflowPath,
		proposeWorkflowPath,
		smithersDbPath,
	});
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

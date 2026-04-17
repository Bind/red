import { createApp } from "./app";
import { TriageOrchestrator } from "./orchestrator";
import { InMemoryRunStore } from "./runs/store";
import { StubTriageWorkflowRunner } from "./workflows/runner";
import { SmithersTriageRunner } from "./workflows/smithers-runner";
import type { TriageWorkflowRunner } from "./workflows/runner";

interface TriageConfig {
	port: number;
	workflowMode: "stub" | "smithers";
	smithersBin?: string;
	investigateWorkflowPath?: string;
	proposeWorkflowPath?: string;
	model?: string;
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
		smithersBin: process.env.TRIAGE_SMITHERS_BIN,
		investigateWorkflowPath: process.env.TRIAGE_INVESTIGATE_WORKFLOW,
		proposeWorkflowPath: process.env.TRIAGE_PROPOSE_WORKFLOW,
		model: process.env.TRIAGE_MODEL ?? "claude-code",
	};
}

function createRunner(config: TriageConfig): TriageWorkflowRunner {
	if (config.workflowMode === "stub") {
		return new StubTriageWorkflowRunner();
	}
	const {
		smithersBin,
		investigateWorkflowPath,
		proposeWorkflowPath,
		model,
	} = config;
	if (!smithersBin || !investigateWorkflowPath || !proposeWorkflowPath || !model) {
		throw new Error(
			"TRIAGE_WORKFLOW_MODE=smithers requires TRIAGE_SMITHERS_BIN, TRIAGE_INVESTIGATE_WORKFLOW, TRIAGE_PROPOSE_WORKFLOW, TRIAGE_MODEL",
		);
	}
	return new SmithersTriageRunner({
		smithersBin,
		investigateWorkflowPath,
		proposeWorkflowPath,
		model,
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

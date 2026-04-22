import { describeHealthContract } from "@red/health";
import { createApp } from "./app";
import { TriageOrchestrator } from "./orchestrator";
import { InMemoryRunStore } from "./runs/store";
import { StubTriageWorkflowRunner } from "./workflows/runner";

describeHealthContract({
	serviceName: "triage",
	loadApp: () => {
		const store = new InMemoryRunStore();
		const orchestrator = new TriageOrchestrator({
			store,
			runner: new StubTriageWorkflowRunner(),
		});
		return createApp({ store, orchestrator });
	},
});

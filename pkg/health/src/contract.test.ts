/**
 * Cross-service contract test: every long-running service must expose a
 * /health endpoint that returns { service, status, commit } at minimum,
 * with the service name matching what we expect.
 *
 * Each entry boots the service's app factory in-process (no HTTP, no
 * containers) and hits /health via app.request(). Pure, fast, deterministic.
 */

import { describe, expect, test } from "bun:test";
import { assertHealthContract } from "./index";

interface ServiceFixture {
	name: string;
	load(): Promise<{ fetch: (req: Request) => Promise<Response> }>;
}

const services: ServiceFixture[] = [
	{
		name: "ctl",
		load: async () => {
			const { createApp } = await import("../../../apps/ctl/index.ts");
			const { app } = createApp({
				port: 0,
				dbPath: ":memory:",
				repoBackend: {
					kind: "git_storage",
					publicUrl: "http://git-server.test",
					defaultOwner: "redc",
					defaultBranch: "main",
					controlPlane: {
						baseUrl: "http://git-server.test",
						username: "admin",
						password: "admin",
					},
				},
				repos: [],
				artifacts: {
					minio: {
						endPoint: "localhost",
						port: 9000,
						useSSL: false,
						accessKey: "x",
						secretKey: "x",
						bucket: "t",
						prefix: "p",
					},
				},
			} as unknown as Parameters<typeof createApp>[0]);
			return app;
		},
	},
	{
		name: "obs",
		load: async () => {
			const { createApp } = await import(
				"../../../apps/obs/src/service/app.ts"
			);
			const {
				InMemoryActiveRequestAggregator,
			} = await import(
				"../../../apps/obs/src/service/collector-service.ts"
			);
			const noopRawStore = {
				async appendBatch() {},
				async listEventsSince() {
					return [];
				},
			};
			const noopRollupStore = { async appendRollups() {} };
			return createApp({
				rawEventStore: noopRawStore,
				rollupStore: noopRollupStore,
				activeRequests: new InMemoryActiveRequestAggregator({
					incompleteGraceMs: 60_000,
				}),
			});
		},
	},
	{
		name: "triage",
		load: async () => {
			const { createApp } = await import("../../../apps/triage/src/app.ts");
			const { InMemoryRunStore } = await import(
				"../../../apps/triage/src/runs/store.ts"
			);
			const { TriageOrchestrator } = await import(
				"../../../apps/triage/src/orchestrator.ts"
			);
			const { StubTriageWorkflowRunner } = await import(
				"../../../apps/triage/src/workflows/runner.ts"
			);
			const store = new InMemoryRunStore();
			const orchestrator = new TriageOrchestrator({
				store,
				runner: new StubTriageWorkflowRunner(),
			});
			return createApp({ store, orchestrator });
		},
	},
];

describe("service health contract", () => {
	for (const service of services) {
		test(`${service.name} /health returns { service, status, commit }`, async () => {
			process.env.GIT_COMMIT = "testcommit";
			const app = await service.load();
			const res = await app.fetch(
				new Request("http://localhost/health", { method: "GET" }),
			);
			expect(res.status).toBe(200);
			const body = await res.json();
			assertHealthContract(body, service.name);
			expect(body.commit).toBe("testcommit");
		});
	}
});

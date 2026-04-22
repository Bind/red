import { describeHealthContract } from "@red/health";
import { createApp } from "../service/app";
import { InMemoryActiveRequestAggregator } from "../service/collector-service";

describeHealthContract({
	serviceName: "obs",
	loadApp: () =>
		createApp({
			rawEventStore: {
				async appendBatch() {},
				async listEventsSince() {
					return [];
				},
			},
			rollupStore: { async appendRollups() {} },
			activeRequests: new InMemoryActiveRequestAggregator({
				incompleteGraceMs: 60_000,
			}),
		}),
});

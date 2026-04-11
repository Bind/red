#!/usr/bin/env bun
import {
	InMemoryActiveRequestAggregator,
	replayCollectorFromRaw,
} from "./service/collector-service";
import { createStores, loadConfig } from "./util/config";

const config = loadConfig();
const deps = createStores(config);
const activeRequests = new InMemoryActiveRequestAggregator({
	incompleteGraceMs: config.incompleteGraceMs,
});
const replayWindowMs = config.replayWindowMs;
const now = new Date();
const since = new Date(now.getTime() - replayWindowMs);

const result = await replayCollectorFromRaw(
	{
		rawEventStore: deps.rawEventStore,
		rollupStore: deps.rollupStore,
		activeRequests,
	},
	since,
	now,
);

console.log(JSON.stringify(result, null, 2));

import type { WideRollupRecord } from "./collector-contract";

export interface RollupBroadcastEvent {
	id: string;
	rollup: WideRollupRecord;
}

type RollupSubscriber = (event: RollupBroadcastEvent) => void | Promise<void>;

export interface ReplayRollupEventsOptions {
	afterId?: string;
	service?: string;
	outcome?: WideRollupRecord["final_outcome"];
	limit?: number;
}

const DEFAULT_MAX_RECENT_EVENTS = 1_000;

function compareEventIds(left: string, right: string): number {
	const leftSplit = left.lastIndexOf(":");
	const rightSplit = right.lastIndexOf(":");
	const leftTs = leftSplit >= 0 ? left.slice(0, leftSplit) : left;
	const rightTs = rightSplit >= 0 ? right.slice(0, rightSplit) : right;
	if (leftTs < rightTs) return -1;
	if (leftTs > rightTs) return 1;
	const leftRequestId = leftSplit >= 0 ? left.slice(leftSplit + 1) : "";
	const rightRequestId = rightSplit >= 0 ? right.slice(rightSplit + 1) : "";
	return leftRequestId.localeCompare(rightRequestId);
}

export class RollupBroadcaster {
	private readonly subscribers = new Set<RollupSubscriber>();
	private readonly recent: RollupBroadcastEvent[] = [];

	constructor(private readonly maxRecentEvents: number = DEFAULT_MAX_RECENT_EVENTS) {}

	subscribe(subscriber: RollupSubscriber): () => void {
		this.subscribers.add(subscriber);
		return () => {
			this.subscribers.delete(subscriber);
		};
	}

	replay(options: ReplayRollupEventsOptions = {}): RollupBroadcastEvent[] {
		const { afterId, service, outcome, limit = 100 } = options;
		const filtered = this.recent.filter((event) => {
			if (afterId && compareEventIds(event.id, afterId) <= 0) return false;
			if (service && event.rollup.entry_service !== service) return false;
			if (outcome && event.rollup.final_outcome !== outcome) return false;
			return true;
		});
		return filtered.slice(-Math.max(limit, 1));
	}

	async publish(rollups: WideRollupRecord[]): Promise<void> {
		if (rollups.length === 0) {
			return;
		}
		const subscribers = Array.from(this.subscribers);
		for (const rollup of rollups) {
			const event: RollupBroadcastEvent = {
				id: `${rollup.rolled_up_at}:${rollup.request_id}`,
				rollup,
			};
			this.recent.push(event);
			if (this.recent.length > this.maxRecentEvents) {
				this.recent.splice(0, this.recent.length - this.maxRecentEvents);
			}
			if (subscribers.length === 0) {
				continue;
			}
			await Promise.all(
				subscribers.map(async (subscriber) => {
					try {
						await subscriber(event);
					} catch {
						// Drop subscriber errors so one slow/broken client does not block fanout.
					}
				}),
			);
		}
	}
}

import type { ChangeQueries, DeliveryQueries, EventQueries, JobQueries } from "../db/queries";
import { ChangeStateMachine } from "../engine/state-machine";
import type { CreatedBy } from "../types";

export interface RefUpdateIngestDeps {
  changes: ChangeQueries;
  events: EventQueries;
  deliveries: DeliveryQueries;
  jobs: JobQueries;
}

export interface RefUpdateInput {
  orgId?: string;
  repo: string;
  branch: string;
  baseBranch: string;
  headSha: string;
  createdBy: CreatedBy;
  deliveryId?: string | null;
  metadata?: Record<string, unknown>;
}

export type RefUpdateIngestResult =
  | { status: "duplicate"; delivery_id: string }
  | { status: "skipped"; reason: "default branch"; delivery_id?: string }
  | { status: "accepted"; change_id: number; superseded_count: number; delivery_id: string | null };

export function ingestRefUpdate(
  deps: RefUpdateIngestDeps,
  input: RefUpdateInput
): RefUpdateIngestResult {
  const deliveryId = input.deliveryId ?? null;
  if (deliveryId && deps.deliveries.isDuplicate(deliveryId)) {
    return { status: "duplicate", delivery_id: deliveryId };
  }

  if (input.branch === input.baseBranch) {
    if (deliveryId) deps.deliveries.record(deliveryId);
    return { status: "skipped", reason: "default branch", delivery_id: deliveryId ?? undefined };
  }

  const change = deps.changes.create({
    org_id: input.orgId ?? "default",
    repo: input.repo,
    branch: input.branch,
    base_branch: input.baseBranch,
    head_sha: input.headSha,
    created_by: input.createdBy,
    delivery_id: deliveryId ?? buildSyntheticDeliveryId(input),
  });

  deps.events.append({
    change_id: change.id,
    event_type: "push_received",
    to_status: "pushed",
    metadata: JSON.stringify(input.metadata ?? {}),
  });

  const stateMachine = new ChangeStateMachine(deps.changes, deps.events);
  const superseded = stateMachine.supersedePrior(input.repo, input.branch, change.id);

  deps.jobs.enqueue({
    org_id: input.orgId ?? "default",
    type: "score_change",
    payload: JSON.stringify({ change_id: change.id }),
  });

  if (deliveryId) deps.deliveries.record(deliveryId);

  return {
    status: "accepted",
    change_id: change.id,
    superseded_count: superseded,
    delivery_id: deliveryId,
  };
}

function buildSyntheticDeliveryId(input: RefUpdateInput): string {
  const entropy = crypto.randomUUID();
  return `local:${input.repo}:${input.branch}:${input.headSha}:${entropy}`;
}

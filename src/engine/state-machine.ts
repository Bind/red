import type { ChangeStatus } from "../types";
import type { ChangeQueries, EventQueries } from "../db/queries";

/**
 * Valid state transitions for the change lifecycle:
 *
 *   pushed → scoring → scored → summarizing → ready_for_review
 *                                                  ↓           ↓
 *                                              approved    rejected
 *                                                  ↓
 *                                              merging → merged
 *                                                ↓   ↑
 *                                          merge_failed
 *                                                  ↓
 *                                               closed
 *
 *   Any state → superseded (new push to same branch)
 */
const VALID_TRANSITIONS: Record<ChangeStatus, ChangeStatus[]> = {
  pushed: ["scoring", "superseded"],
  scoring: ["scored", "superseded"],
  scored: ["summarizing", "superseded"],
  summarizing: ["ready_for_review", "superseded"],
  ready_for_review: ["approved", "rejected", "superseded"],
  approved: ["merging", "superseded"],
  rejected: ["superseded"],
  merging: ["merged", "merge_failed", "closed", "superseded"],
  merge_failed: ["merging", "superseded"],
  merged: [],
  closed: [],
  superseded: [],
};

export class InvalidTransitionError extends Error {
  constructor(
    public from: ChangeStatus,
    public to: ChangeStatus
  ) {
    super(`Invalid transition: ${from} → ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export class ChangeStateMachine {
  constructor(
    private changes: ChangeQueries,
    private events: EventQueries
  ) {}

  /** Transition a change to a new status with validation and event logging. */
  transition(
    changeId: number,
    toStatus: ChangeStatus,
    metadata?: Record<string, unknown>
  ): void {
    const change = this.changes.getById(changeId);
    if (!change) {
      throw new Error(`Change ${changeId} not found`);
    }

    const fromStatus = change.status;

    if (!VALID_TRANSITIONS[fromStatus]?.includes(toStatus)) {
      throw new InvalidTransitionError(fromStatus, toStatus);
    }

    this.changes.updateStatus(changeId, toStatus);
    this.events.append({
      change_id: changeId,
      event_type: "status_change",
      from_status: fromStatus,
      to_status: toStatus,
      metadata: metadata ? JSON.stringify(metadata) : null,
    });
  }

  /** Mark all open changes on a repo+branch as superseded (new push arrived). */
  supersedePrior(
    repo: string,
    branch: string,
    excludeId: number
  ): number {
    return this.changes.supersedePrior(repo, branch, excludeId);
  }

  /** Check if a transition is valid without performing it. */
  canTransition(from: ChangeStatus, to: ChangeStatus): boolean {
    return VALID_TRANSITIONS[from]?.includes(to) ?? false;
  }
}

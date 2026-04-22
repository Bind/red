import type { Daemon, DaemonContext, TickResult } from "../daemon";
import type { Healer } from "../healers/types";
import type { ChangeStore } from "../world/change-store";

export type PRHealthOptions = {
  intervalMs?: number;
  defaultReviewer?: string;
  store: ChangeStore;
  healer: Healer;
};

export function createPRHealthDaemon(options: PRHealthOptions): Daemon {
  const intervalMs = options.intervalMs ?? 2_000;
  const defaultReviewer = options.defaultReviewer ?? "red-bot";
  const { store, healer } = options;

  return {
    name: "pr-health",
    intervalMs,
    async tick(ctx: DaemonContext): Promise<TickResult> {
      const changes = store.list();
      let healed = 0;
      let errors = 0;

      for (const change of changes) {
        const staleSummary =
          change.summary === null || change.summaryForSha !== change.commitSha;
        const missingReviewer = change.reviewers.length === 0;

        if (staleSummary) {
          const seenKey = `pr-health:summary-sha:${change.id}`;
          const lastHealedSha = ctx.memory.get(seenKey);
          if (lastHealedSha === change.commitSha) {
            ctx.emit({
              kind: "daemon.finding.skipped",
              route_name: "pr-health",
              data: { changeId: change.id, reason: "already_healed_for_sha" },
            });
          } else {
            try {
              ctx.emit({
                kind: "daemon.finding",
                route_name: "pr-health",
                data: {
                  changeId: change.id,
                  invariant: "summary_matches_commit",
                  previousSha: change.summaryForSha,
                  currentSha: change.commitSha,
                },
              });
              const summary = await healer.summarize({
                changeId: change.id,
                title: change.title,
                commitSha: change.commitSha,
              });
              store.setSummary(change.id, summary, change.commitSha);
              ctx.memory.set(seenKey, change.commitSha);
              healed += 1;
              ctx.emit({
                kind: "daemon.action.applied",
                route_name: "pr-health",
                data: {
                  changeId: change.id,
                  action: "regenerated_summary",
                  healer: healer.name,
                },
              });
            } catch (err) {
              errors += 1;
              ctx.emit({
                kind: "daemon.action.failed",
                route_name: "pr-health",
                data: {
                  changeId: change.id,
                  action: "regenerated_summary",
                  error: err instanceof Error ? err.message : String(err),
                },
              });
            }
          }
        }

        if (missingReviewer) {
          try {
            store.assignReviewer(change.id, defaultReviewer);
            healed += 1;
            ctx.emit({
              kind: "daemon.action.applied",
              route_name: "pr-health",
              data: {
                changeId: change.id,
                action: "assigned_default_reviewer",
                reviewer: defaultReviewer,
              },
            });
          } catch (err) {
            errors += 1;
            ctx.emit({
              kind: "daemon.action.failed",
              route_name: "pr-health",
              data: {
                changeId: change.id,
                action: "assigned_default_reviewer",
                error: err instanceof Error ? err.message : String(err),
              },
            });
          }
        }
      }

      return { checked: changes.length, healed, errors };
    },
  };
}

import type { Daemon, DaemonContext, TickResult } from "../daemon";
import type { IssueStore } from "../world/issue-store";

export type StaleIssueOptions = {
  intervalMs?: number;
  staleAfterDays?: number;
  store: IssueStore;
};

export function createStaleIssueDaemon(options: StaleIssueOptions): Daemon {
  const intervalMs = options.intervalMs ?? 5_000;
  const staleAfterDays = options.staleAfterDays ?? 7;
  const { store } = options;

  return {
    name: "stale-issue",
    intervalMs,
    async tick(ctx: DaemonContext): Promise<TickResult> {
      const issues = store.list();
      const now = ctx.now();
      const thresholdMs = staleAfterDays * 24 * 60 * 60 * 1000;
      let healed = 0;
      let errors = 0;

      for (const issue of issues) {
        const age = now.getTime() - issue.openedAt.getTime();
        const untriaged = issue.labels.length === 0 && age >= thresholdMs;
        if (!untriaged) continue;

        const seenKey = `stale-issue:triaged:${issue.id}`;
        if (ctx.memory.get(seenKey)) {
          ctx.emit({
            kind: "daemon.finding.skipped",
            route_name: "stale-issue",
            data: { issueId: issue.id, reason: "already_triaged" },
          });
          continue;
        }

        try {
          ctx.emit({
            kind: "daemon.finding",
            route_name: "stale-issue",
            data: {
              issueId: issue.id,
              invariant: "open_issue_has_label_within_window",
              ageMs: age,
              staleAfterDays,
            },
          });
          store.addLabel(issue.id, "needs-triage");
          store.addComment(issue.id, "daemon: auto-labelled as needs-triage");
          ctx.memory.set(seenKey, true);
          healed += 1;
          ctx.emit({
            kind: "daemon.action.applied",
            route_name: "stale-issue",
            data: { issueId: issue.id, action: "labelled_needs_triage" },
          });
        } catch (err) {
          errors += 1;
          ctx.emit({
            kind: "daemon.action.failed",
            route_name: "stale-issue",
            data: {
              issueId: issue.id,
              action: "labelled_needs_triage",
              error: err instanceof Error ? err.message : String(err),
            },
          });
        }
      }

      return { checked: issues.length, healed, errors };
    },
  };
}

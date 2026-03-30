import { cn } from "@/lib/utils";
import type { ChangeStatus } from "@/lib/api";

const STATES: { id: ChangeStatus; label: string }[] = [
  { id: "pushed", label: "pushed" },
  { id: "scoring", label: "scoring" },
  { id: "scored", label: "scored" },
  { id: "summarizing", label: "summarizing" },
  { id: "ready_for_review", label: "review" },
  { id: "approved", label: "approved" },
  { id: "merging", label: "merging" },
  { id: "merged", label: "merged" },
];

const BRANCHES: { id: ChangeStatus; label: string; afterIdx: number }[] = [
  { id: "rejected", label: "rejected", afterIdx: 4 },       // branches off ready_for_review
  { id: "merge_failed", label: "merge failed", afterIdx: 6 }, // branches off merging
];

// Order for determining "past" states
const STATE_ORDER: ChangeStatus[] = [
  "pushed",
  "scoring",
  "scored",
  "summarizing",
  "ready_for_review",
  "approved",
  "merging",
  "merged",
];

function getStateIndex(status: ChangeStatus): number {
  return STATE_ORDER.indexOf(status);
}

interface StateMachineProps {
  activeStatus?: ChangeStatus | null;
  className?: string;
}

export function StateMachine({ activeStatus, className }: StateMachineProps) {
  const activeIdx = activeStatus ? getStateIndex(activeStatus) : -1;
  const isBranch = BRANCHES.some((b) => b.id === activeStatus);

  return (
    <div className={cn("space-y-2", className)}>
      {/* Main flow */}
      <div className="flex flex-wrap items-center gap-1 sm:gap-0">
        {STATES.map((state, i) => {
          const idx = getStateIndex(state.id);
          const isActive = activeStatus === state.id;
          const isPast = !isBranch && activeIdx > idx;

          return (
            <div key={state.id} className="flex items-center">
              <span
                className={cn(
                  "rounded px-1.5 py-0.5 font-mono text-xs transition-colors",
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : isPast
                      ? "bg-muted text-foreground"
                      : "text-muted-foreground"
                )}
              >
                {state.label}
              </span>
              {i < STATES.length - 1 && (
                <span
                  className={cn(
                    "mx-0.5 hidden text-xs sm:inline",
                    isPast ? "text-foreground" : "text-muted-foreground/40"
                  )}
                >
                  →
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Branch states (rejected, merge_failed) */}
      {BRANCHES.map((branch) => (
        <div key={branch.id} className="flex items-center gap-1">
          <span className="text-xs text-muted-foreground/40 sm:inline hidden">↳</span>
          <span
            className={cn(
              "rounded px-1.5 py-0.5 font-mono text-xs",
              activeStatus === branch.id
                ? "bg-destructive text-destructive-foreground"
                : "text-muted-foreground/40"
            )}
          >
            {branch.label}
          </span>
        </div>
      ))}
    </div>
  );
}

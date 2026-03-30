import { useEffect, useState } from "react";
import { useParams, Link } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StateMachine } from "@/components/state-machine";
import { fetchChange, approveChange, retryMerge, type ChangeDetail, type ChangeStatus } from "@/lib/api";

function timeAgo(dateStr: string): string {
  // SQLite datetime('now') returns UTC without Z suffix — append it
  const normalized = dateStr.includes("T") || dateStr.includes("Z") ? dateStr : dateStr + "Z";
  const seconds = Math.floor((Date.now() - new Date(normalized).getTime()) / 1000);
  if (isNaN(seconds) || seconds < 0) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const FORWARD_STATES: ChangeStatus[] = [
  "pushed", "scoring", "scored", "summarizing",
  "ready_for_review", "approved", "merging", "merged",
];

function timelineDotColor(toStatus: ChangeStatus | null): string {
  if (!toStatus) return "bg-muted-foreground";
  if (toStatus === "rejected" || toStatus === "closed" || toStatus === "merge_failed") return "bg-destructive";
  if (FORWARD_STATES.includes(toStatus)) return "bg-primary";
  return "bg-muted-foreground";
}

export function ChangeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [change, setChange] = useState<ChangeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [retrying, setRetrying] = useState(false);

  const loadChange = () => {
    if (!id) return;
    fetchChange(parseInt(id, 10))
      .then(setChange)
      .catch((err) => setError(err.message));
  };

  useEffect(() => {
    loadChange();
    const interval = setInterval(loadChange, 3000);
    return () => clearInterval(interval);
  }, [id]);

  const handleApprove = async () => {
    if (!change) return;
    setApproving(true);
    try {
      await approveChange(change.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Approve failed");
    } finally {
      setApproving(false);
    }
  };

  const handleRetryMerge = async () => {
    if (!change) return;
    setRetrying(true);
    try {
      await retryMerge(change.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Retry failed");
    } finally {
      setRetrying(false);
    }
  };

  if (error) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/">&larr; Back</Link>
        </Button>
        <p className="text-destructive">{error}</p>
      </div>
    );
  }

  if (!change) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-6 w-24" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" asChild>
        <Link to="/">&larr; Back</Link>
      </Button>

      {/* State machine showing current position */}
      <StateMachine activeStatus={change.status} />

      {change.status === "ready_for_review" && (
        <Button onClick={handleApprove} disabled={approving}>
          {approving ? "Approving..." : "Approve & Merge"}
        </Button>
      )}

      {change.status === "merge_failed" && (
        <Card className="border-destructive">
          <CardContent className="pt-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-destructive">Merge failed</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {change.events
                    .filter((e) => e.event_type === "merge_failed")
                    .slice(-1)
                    .map((e) => {
                      try { return JSON.parse(e.metadata ?? "{}").error; } catch { return null; }
                    })[0] || "Unknown error"}
                </p>
              </div>
              <Button onClick={handleRetryMerge} disabled={retrying} variant="destructive" size="sm">
                {retrying ? "Retrying..." : "Retry Merge"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-xl">
              {change.repo}
              <span className="ml-2 font-mono text-base font-normal text-muted-foreground">
                {change.branch}
              </span>
            </CardTitle>
            <div className="flex gap-2">
              <Badge
                variant={
                  change.status === "merged" || change.status === "approved"
                    ? "default"
                    : change.status === "rejected" || change.status === "closed"
                      ? "destructive"
                      : "secondary"
                }
              >
                {change.status}
              </Badge>
              {change.confidence && (
                <Badge
                  variant={
                    change.confidence === "safe"
                      ? "default"
                      : change.confidence === "critical"
                        ? "destructive"
                        : "secondary"
                  }
                >
                  {change.confidence}
                </Badge>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">Base</dt>
              <dd className="font-mono">{change.base_branch}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Source</dt>
              <dd>{change.created_by}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">SHA</dt>
              <dd className="font-mono">{change.head_sha.slice(0, 8)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Created</dt>
              <dd>{timeAgo(change.created_at)}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      {change.summary && (() => {
        try {
          const summary = JSON.parse(change.summary) as {
            title?: string;
            what_changed: string;
            risk_assessment: string;
            affected_modules: string[];
            recommended_action: string;
          };
          return (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">
                  {summary.title || "Summary"}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <p className="text-sm">{summary.what_changed}</p>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">Risk</dt>
                  <dd className="text-sm">{summary.risk_assessment}</dd>
                </div>
                {summary.affected_modules.length > 0 && (
                  <div>
                    <dt className="text-xs text-muted-foreground">Modules</dt>
                    <dd className="flex flex-wrap gap-1 mt-1">
                      {summary.affected_modules.map((mod) => (
                        <Badge key={mod} variant="outline" className="font-mono text-xs">
                          {mod}
                        </Badge>
                      ))}
                    </dd>
                  </div>
                )}
              </CardContent>
            </Card>
          );
        } catch {
          return (
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Summary</CardTitle>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground whitespace-pre-wrap">
                  {change.summary}
                </p>
              </CardContent>
            </Card>
          );
        }
      })()}

      {change.diff_stats && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Diff Stats</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex gap-6 text-sm">
              <span>
                <span className="font-medium">{change.diff_stats.files_changed}</span>{" "}
                <span className="text-muted-foreground">files changed</span>
              </span>
              <span className="text-green-500">+{change.diff_stats.additions}</span>
              <span className="text-red-500">-{change.diff_stats.deletions}</span>
            </div>
          </CardContent>
        </Card>
      )}

      {change.events.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Timeline</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="space-y-3">
              {change.events.map((event) => (
                <li key={event.id} className="flex items-start gap-3 text-sm">
                  <span
                    className={`mt-0.5 h-2 w-2 shrink-0 rounded-full ${timelineDotColor(event.to_status)}`}
                  />
                  <div>
                    <span className="font-medium">{event.event_type}</span>
                    {event.from_status && event.to_status && (
                      <span className="text-muted-foreground">
                        {" "}
                        {event.from_status} &rarr; {event.to_status}
                      </span>
                    )}
                    <span className="ml-2 text-muted-foreground">
                      {timeAgo(event.created_at)}
                    </span>
                  </div>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { StateMachine } from "@/components/state-machine";
import { PatchDiff } from "@pierre/diffs/react";
import { FileTree } from "@pierre/trees/react";
import type { GitStatusEntry } from "@pierre/trees";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useHeaderContent } from "@/components/layout";
import { fetchChange, fetchDiff, approveChange, retryMerge, regenerateSummary, subscribeToLogs, type ChangeDetail, type ChangeStatus, type ChangeEvent } from "@/lib/api";

function Timeline({ events }: { events: ChangeEvent[] }) {
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium text-muted-foreground">Timeline</h3>
      <div className="relative space-y-0">
        {events.map((event, i) => (
          <div key={event.id} className="flex items-start gap-3 pb-3">
            <div className="flex flex-col items-center">
              <div className="h-2 w-2 rounded-full bg-muted-foreground mt-1.5" />
              {i < events.length - 1 && <div className="w-px flex-1 bg-border" />}
            </div>
            <div className="flex-1 text-sm">
              <span className="text-foreground">{event.event_type}</span>
              {event.from_status && event.to_status && (
                <span className="text-muted-foreground">
                  {" "}{event.from_status} &rarr; {event.to_status}
                </span>
              )}
              <span className="ml-2 text-xs text-muted-foreground">{timeAgo(event.created_at)}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface SummaryAnnotation {
  text: string;
  files: string[];
  type: "new_module" | "refactor" | "bugfix" | "config" | "change";
}

const annotationTypeLabel: Record<SummaryAnnotation["type"], string> = {
  new_module: "new",
  refactor: "refactor",
  bugfix: "fix",
  config: "config",
  change: "change",
};

const annotationTypeColor: Record<SummaryAnnotation["type"], string> = {
  new_module: "bg-emerald-500/15 text-emerald-400",
  refactor: "bg-blue-500/15 text-blue-400",
  bugfix: "bg-amber-500/15 text-amber-400",
  config: "bg-purple-500/15 text-purple-400",
  change: "bg-zinc-500/15 text-zinc-400",
};

const diffOptions = {
  theme: "pierre-dark" as const,
  themeType: "dark" as const,
  diffStyle: "unified" as const,
  unsafeCSS: `
    :host {
      --diffs-dark-bg: #0d0d0d;
      --diffs-dark: #fbfbfb;
      --diffs-deletion-color-override: #e85450;
      --diffs-addition-color-override: #5ecc71;
      --diffs-font-family: 'Geist Mono Variable', monospace;
      --diffs-header-font-family: 'Geist Variable', sans-serif;
      border-radius: 0.25rem;
      overflow: hidden;
    }
  `,
};

const treeOptions = {
  flattenEmptyDirectories: true,
  unsafeCSS: `
    :host {
      --trees-bg-override: #0d0d0d;
      --trees-fg-override: #fbfbfb;
      --trees-accent-override: #e85450;
      --trees-font-size-override: 13px;
    }
  `,
};

/** Parse unified diff to extract file paths and git status. */
function parseDiffFiles(diff: string): { files: string[]; gitStatus: GitStatusEntry[] } {
  const files: string[] = [];
  const gitStatus: GitStatusEntry[] = [];
  for (const chunk of diff.split(/(?=^diff --git )/m)) {
    const header = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    if (!header) continue;
    const path = header[2];
    files.push(path);
    // Detect status from diff metadata
    let status: GitStatusEntry["status"] = "modified";
    if (/^new file mode/m.test(chunk)) status = "added";
    else if (/^deleted file mode/m.test(chunk)) status = "deleted";
    gitStatus.push({ path, status });
  }
  return { files, gitStatus };
}

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

function scrollToDiffFile(filename: string) {
  const el = document.querySelector(`[data-diff-file="${filename}"]`);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

function AnnotatedSummary({ text, annotations }: { text: string; annotations?: SummaryAnnotation[] }) {
  if (!annotations || annotations.length === 0) {
    return <p className="text-sm">{text}</p>;
  }

  // Build segments: try to match annotation text within the summary
  const segments: { content: string; annotation?: SummaryAnnotation }[] = [];
  let remaining = text;

  // Sort annotations by their position in the text
  const sorted = [...annotations]
    .map((a) => ({ annotation: a, index: remaining.indexOf(a.text) }))
    .filter((a) => a.index !== -1)
    .sort((a, b) => a.index - b.index);

  let cursor = 0;
  for (const { annotation, index } of sorted) {
    // Text before this annotation
    if (index > cursor) {
      segments.push({ content: text.slice(cursor, index) });
    }
    segments.push({ content: annotation.text, annotation });
    cursor = index + annotation.text.length;
  }
  // Remaining text after last annotation
  if (cursor < text.length) {
    segments.push({ content: text.slice(cursor) });
  }

  // If no annotations matched, just render plain text
  if (sorted.length === 0) {
    return <p className="text-sm">{text}</p>;
  }

  return (
    <p className="text-sm">
      <TooltipProvider>
        {segments.map((seg, i) => {
          if (!seg.annotation) {
            return <span key={i}>{seg.content}</span>;
          }
          const ann = seg.annotation;
          return (
            <Tooltip key={i}>
              <TooltipTrigger asChild>
                <span
                  className="underline decoration-dotted decoration-muted-foreground/50 underline-offset-4 cursor-pointer hover:decoration-foreground transition-colors"
                  onClick={() => ann.files[0] && scrollToDiffFile(ann.files[0])}
                >
                  {seg.content}
                </span>
              </TooltipTrigger>
              <TooltipContent side="top" className="flex flex-col gap-1.5 max-w-sm">
                <span className={`inline-flex w-fit px-1.5 py-0.5 rounded text-[10px] font-medium uppercase tracking-wide ${annotationTypeColor[ann.type]}`}>
                  {annotationTypeLabel[ann.type]}
                </span>
                <div className="flex flex-col gap-0.5">
                  {ann.files.map((f) => (
                    <span key={f} className="font-mono text-[11px]">{f}</span>
                  ))}
                </div>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </TooltipProvider>
    </p>
  );
}

function LogViewer({ changeId }: { changeId: number }) {
  const [lines, setLines] = useState<string[]>([]);
  const [done, setDone] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const cleanup = subscribeToLogs(
      changeId,
      (line) => setLines((prev) => [...prev, line]),
      () => setDone(true),
    );
    return cleanup;
  }, [changeId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          {!done && (
            <span className="relative flex h-2.5 w-2.5">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
              <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-primary" />
            </span>
          )}
          <CardTitle className="text-base">
            {done ? "Codex Logs" : "Codex is working..."}
          </CardTitle>
        </div>
      </CardHeader>
      <CardContent>
        <pre className="bg-[#0d0d0d] text-[#a1a1aa] text-xs font-mono p-4 rounded-md max-h-80 overflow-y-auto whitespace-pre-wrap break-all">
          {lines.length === 0 && !done && (
            <span className="text-muted-foreground">Waiting for logs...</span>
          )}
          {lines.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
          <div ref={bottomRef} />
        </pre>
      </CardContent>
    </Card>
  );
}

export function ChangeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [change, setChange] = useState<ChangeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);
  const setHeaderContent = useHeaderContent();

  // Push change info into the layout header
  useEffect(() => {
    if (!change) {
      setHeaderContent(null);
      return;
    }
    setHeaderContent(
      <div className="mt-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-lg font-semibold text-foreground">{change.repo}</span>
            <span className="font-mono text-sm text-muted-foreground">{change.branch}</span>
          </div>
        </div>
        <dl className="flex gap-6 text-sm">
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
      </div>
    );
    return () => setHeaderContent(null);
  }, [change, setHeaderContent]);

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

  useEffect(() => {
    if (!id) return;
    fetchDiff(parseInt(id, 10))
      .then(setDiff)
      .catch(() => {}); // diff is optional — don't block the page
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

  const handleRegenerateSummary = async () => {
    if (!change) return;
    setRegenerating(true);
    try {
      await regenerateSummary(change.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Regenerate failed");
    } finally {
      setRegenerating(false);
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

      {change.status === "summarizing" && (
        <LogViewer changeId={change.id} />
      )}

      {change.status === "ready_for_review" && (
        <div className="flex gap-2">
          <Button onClick={handleApprove} disabled={approving}>
            {approving ? "Approving..." : "Approve & Merge"}
          </Button>
        </div>
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

      {change.summary && (() => {
        try {
          const summary = JSON.parse(change.summary) as {
            title?: string;
            what_changed: string;
            risk_assessment: string;
            affected_modules: string[];
            recommended_action: string;
            annotations?: SummaryAnnotation[];
          };
          return (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">
                    {summary.title || "Summary"}
                  </CardTitle>
                  {change.status === "ready_for_review" && (
                    <Button variant="outline" size="sm" onClick={handleRegenerateSummary} disabled={regenerating}>
                      {regenerating ? "Regenerating..." : "Regenerate Summary"}
                    </Button>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <AnnotatedSummary text={summary.what_changed} annotations={summary.annotations} />
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

      {diff && (() => {
        const patches = diff.split(/(?=^diff --git )/m).filter(Boolean);
        const { files, gitStatus } = parseDiffFiles(diff);
        return (
          <div className="flex gap-4 items-start">
            <div className="w-64 shrink-0 sticky top-4 rounded border border-border overflow-hidden">
              <FileTree
                options={treeOptions}
                files={files}
                gitStatus={gitStatus}
              />
            </div>
            <div className="flex-1 min-w-0 space-y-3">
              {patches.map((filePatch, i) => (
                <div key={i} data-diff-file={files[i]}>
                  <PatchDiff patch={filePatch} options={diffOptions} />
                </div>
              ))}
            </div>
          </div>
        );
      })()}


      {change.events.length > 0 && <Timeline events={change.events} />}
    </div>
  );
}

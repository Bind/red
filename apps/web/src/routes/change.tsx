import { useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { StateMachine } from "@/components/state-machine";
import { PatchDiff } from "@pierre/diffs/react";
import { FileTree } from "@pierre/trees/react";
import type { GitStatusEntry } from "@pierre/trees";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useHeaderContent } from "@/components/layout";
import { fetchChange, fetchDiff, regenerateSummary, requeueSummary, subscribeToAgentEvents, fetchSessions, type ChangeDetail, type ChangeStatus, type ChangeEvent, type AgentSession, type AgentSessionEvent } from "@/lib/api";

interface SummaryGeneratorMetadata {
  action_id?: string;
  prompt_name?: string;
  prompt_path?: string;
  prompt_hash?: string;
  surfaces?: string[];
}

interface SummaryGeneratedMetadata {
  recommended_action?: string;
  generator?: SummaryGeneratorMetadata | null;
}

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
  "ready_for_review",
];

function timelineDotColor(toStatus: ChangeStatus | null): string {
  if (!toStatus) return "bg-muted-foreground";
  if (toStatus === "superseded") return "bg-muted-foreground";
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

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSec = seconds % 60;
  return `${minutes}m ${remainingSec}s`;
}

function parseSummaryGeneratedMetadata(events: ChangeEvent[]): SummaryGeneratedMetadata | null {
  const event = [...events].reverse().find((entry) => entry.event_type === "summary_generated");
  if (!event?.metadata) return null;
  try {
    return JSON.parse(event.metadata) as SummaryGeneratedMetadata;
  } catch {
    return null;
  }
}

function LogViewer({ changeId, isSummarizing }: { changeId: number; isSummarizing: boolean }) {
  const [events, setEvents] = useState<AgentSessionEvent[]>([]);
  const [done, setDone] = useState(false);
  const [sessions, setSessions] = useState<AgentSession[] | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Fetch sessions on mount
  useEffect(() => {
    fetchSessions(changeId).then((s) => {
      setSessions(s);
      if (s.length > 0 && s[0].duration_ms) {
        setDurationMs(s[0].duration_ms);
      }
    }).catch(() => setSessions([]));
  }, [changeId]);

  // If summarizing: connect to SSE (server handles replay + live)
  // If completed session exists: also connect to SSE (server replays persisted logs)
  useEffect(() => {
    if (sessions === null) return; // still loading
    const latestSession = sessions[0];
    const hasSession = latestSession != null;

    // No session and not summarizing — nothing to show
    if (!hasSession && !isSummarizing) return;

    const cleanup = subscribeToAgentEvents(
      changeId,
      (event) => {
        setEvents((prev) => [...prev, event]);
      },
      (doneData) => {
        setDone(true);
        if (doneData) {
          try {
            const parsed = JSON.parse(doneData);
            if (parsed.duration_ms) setDurationMs(parsed.duration_ms);
          } catch {}
        }
      },
    );
    return cleanup;
  }, [changeId, sessions, isSummarizing]);

  useEffect(() => {
    const viewport = bottomRef.current?.closest("[data-slot='scroll-area-viewport']");
    if (!(viewport instanceof HTMLElement)) return;
    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior: "smooth",
    });
  }, [events]);

  // Don't render anything if there are no sessions and we're not summarizing
  if (sessions !== null && sessions.length === 0 && !isSummarizing) return null;
  // Still loading sessions
  if (sessions === null) return null;

  const latestSession = sessions[0] ?? null;
  const transcriptEvents = events.filter((event) => shouldRenderTranscriptEvent(event));
  const rawStream = events
    .map((event) => event.raw_json ?? event.data_json ?? event.text ?? null)
    .filter((value): value is string => Boolean(value));
  const artifactEvents = events.filter((event) => event.kind === "artifact");

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              {!done && (
                <span className="relative flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75" />
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-primary" />
                </span>
              )}
              <CardTitle className="text-base">
                {done ? "Agent Run" : "Agent Session"}
              </CardTitle>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <Badge variant="outline" className="font-mono text-[11px]">
                {latestSession?.runtime ?? "agent"}
              </Badge>
              <Badge variant={done && latestSession?.status === "failed" ? "destructive" : "secondary"} className="text-[11px]">
                {done ? latestSession?.status ?? "completed" : "running"}
              </Badge>
              {latestSession?.runtime_session_id && (
                <Badge variant="outline" className="font-mono text-[11px]">
                  {latestSession.runtime_session_id}
                </Badge>
              )}
            </div>
          </div>
          <div className="text-right">
            {durationMs != null && (
              <p className="text-sm font-medium">{formatDuration(durationMs)}</p>
            )}
            <p className="text-xs text-muted-foreground">
              {events.length} event{events.length === 1 ? "" : "s"}
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <Tabs defaultValue="transcript" className="gap-4">
          <TabsList variant="line">
            <TabsTrigger value="transcript">Transcript</TabsTrigger>
            <TabsTrigger value="timeline">Timeline</TabsTrigger>
            <TabsTrigger value="raw">Raw</TabsTrigger>
          </TabsList>

          <TabsContent value="transcript">
            <div className="rounded-xl border border-border bg-muted/20">
              <ScrollArea className="h-96">
                <div className="space-y-3 p-4">
                  {transcriptEvents.length === 0 && !done && (
                    <div className="rounded-lg border border-dashed border-border bg-background/70 px-4 py-6 text-sm text-muted-foreground">
                      Waiting for the first session event...
                    </div>
                  )}
                  {transcriptEvents.map((event) => (
                    <TranscriptEventRow key={event.id} event={event} />
                  ))}
                  <div ref={bottomRef} />
                </div>
              </ScrollArea>
              {artifactEvents.length > 0 && (
                <>
                  <Separator />
                  <div className="flex flex-wrap gap-2 p-4">
                    {artifactEvents.map((event) => (
                      <ArtifactBadge key={event.id} event={event} />
                    ))}
                  </div>
                </>
              )}
            </div>
          </TabsContent>

          <TabsContent value="timeline">
            <div className="rounded-xl border border-border bg-muted/20 p-4">
              <div className="space-y-3">
                {events.length === 0 && !done && (
                  <p className="text-sm text-muted-foreground">Waiting for the first session event...</p>
                )}
                {events.map((event) => (
                  <TimelineEventRow key={event.id} event={event} />
                ))}
              </div>
            </div>
          </TabsContent>

          <TabsContent value="raw">
            <div className="overflow-hidden rounded-xl border border-border bg-[#0d0d0d]">
              <ScrollArea className="h-96">
                <pre className="p-4 text-xs font-mono text-[#a1a1aa] whitespace-pre-wrap break-all">
                  {rawStream.length === 0 && !done && (
                    <span className="text-muted-foreground">Waiting for raw events...</span>
                  )}
                  {rawStream.map((chunk, i) => (
                    <div key={i} className="pb-3 last:pb-0">
                      {chunk}
                    </div>
                  ))}
                </pre>
              </ScrollArea>
            </div>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function shouldRenderTranscriptEvent(event: AgentSessionEvent): boolean {
  if (event.kind === "message") return true;
  if (event.kind === "artifact") return false;
  return event.kind === "lifecycle";
}

function TranscriptEventRow({ event }: { event: AgentSessionEvent }) {
  if (event.kind === "message") {
    const parsed = tryParseJson(event.text);
    if (parsed && isRecord(parsed)) {
      const preview = buildStructuredPreview(parsed);
      return (
        <div className="rounded-xl border border-border bg-background shadow-sm">
          <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
            <div className="flex items-center gap-2">
              <Badge variant="secondary" className="text-[11px]">assistant</Badge>
              <span className="text-sm font-medium">Structured response</span>
            </div>
            <span className="text-xs text-muted-foreground">{timeAgo(event.created_at)}</span>
          </div>
          <div className="px-4 py-3">
            {preview && (
              <p className="text-sm text-muted-foreground">
                {preview}
              </p>
            )}
            <Accordion type="single" collapsible className="mt-2 w-full">
              <AccordionItem value="structured-output" className="border-b-0">
                <AccordionTrigger className="py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground hover:no-underline">
                  View structured output
                </AccordionTrigger>
                <AccordionContent className="pt-1">
                  <dl className="grid gap-3">
                    {Object.entries(parsed).map(([key, value]) => (
                      <div key={key} className="grid gap-1">
                        <dt className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                          {formatKeyLabel(key)}
                        </dt>
                        <dd className="text-sm text-foreground">
                          {renderStructuredValue(value)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </div>
        </div>
      );
    }

    return (
      <div className="rounded-xl border border-border bg-background px-4 py-3 shadow-sm">
        <div className="mb-2 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-[11px]">
              {event.role ?? "assistant"}
            </Badge>
            <span className="text-sm font-medium">Message</span>
          </div>
          <span className="text-xs text-muted-foreground">{timeAgo(event.created_at)}</span>
        </div>
        <p className="whitespace-pre-wrap break-words text-sm text-foreground">{event.text}</p>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-3 rounded-xl border border-border/80 bg-muted/30 px-4 py-3">
      <div className={`mt-1 h-2.5 w-2.5 rounded-full ${event.status === "failed" ? "bg-destructive" : event.status === "completed" ? "bg-emerald-500" : "bg-primary"}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium text-foreground">{formatEventLabel(event)}</p>
          <span className="text-xs text-muted-foreground">{timeAgo(event.created_at)}</span>
        </div>
        {(event.text || event.status) && (
          <p className="mt-1 whitespace-pre-wrap break-words text-sm text-muted-foreground">
            {event.text ?? event.status}
          </p>
        )}
      </div>
    </div>
  );
}

function TimelineEventRow({ event }: { event: AgentSessionEvent }) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex flex-col items-center">
        <div className={`mt-1 h-2.5 w-2.5 rounded-full ${event.status === "failed" ? "bg-destructive" : event.status === "completed" ? "bg-emerald-500" : "bg-primary/80"}`} />
        <div className="mt-1 w-px flex-1 bg-border" />
      </div>
      <div className="min-w-0 flex-1 pb-3">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-medium">{formatEventLabel(event)}</p>
          <span className="text-xs text-muted-foreground">{timeAgo(event.created_at)}</span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="text-[11px]">
            {event.kind}
          </Badge>
          {event.status && (
            <Badge variant="secondary" className="text-[11px]">
              {event.status}
            </Badge>
          )}
        </div>
        {event.text && (
          <p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">
            {event.text}
          </p>
        )}
      </div>
    </div>
  );
}

function ArtifactBadge({ event }: { event: AgentSessionEvent }) {
  const data = tryParseJson(event.data_json);
  const label = isRecord(data) && typeof data.artifactKind === "string"
    ? data.artifactKind
    : "artifact";

  return (
    <Badge variant="outline" className="gap-1 font-mono text-[11px]">
      {label}
    </Badge>
  );
}

function formatEventLabel(event: AgentSessionEvent): string {
  const map: Record<string, string> = {
    "session.started": "Session started",
    "session.completed": "Session completed",
    "session.failed": "Session failed",
    "step.started": "Model step started",
    "step.completed": "Model step completed",
    "tool.used": "Tool activity",
    "result.completed": "Result prepared",
    "artifact.available": "Artifact available",
  };

  return map[event.type] ?? event.type.replaceAll(".", " ");
}

function tryParseJson(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatKeyLabel(key: string): string {
  return key.replaceAll("_", " ");
}

function buildStructuredPreview(value: Record<string, unknown>): string | null {
  const title = typeof value.title === "string" ? value.title : null;
  const whatChanged = typeof value.what_changed === "string" ? value.what_changed : null;
  const risk = typeof value.risk_assessment === "string" ? value.risk_assessment : null;

  return [title, whatChanged, risk]
    .filter((entry): entry is string => Boolean(entry))
    .join(" ");
}

function renderStructuredValue(value: unknown) {
  if (typeof value === "string") {
    return <span className="whitespace-pre-wrap break-words">{value}</span>;
  }

  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {value.map((entry) => (
          <Badge key={entry} variant="outline" className="font-mono text-[11px]">
            {entry}
          </Badge>
        ))}
      </div>
    );
  }

  return (
    <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs font-mono text-muted-foreground">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function ChangeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [change, setChange] = useState<ChangeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const [requeueing, setRequeueing] = useState(false);
  const [diff, setDiff] = useState<string | null>(null);
  const setHeaderContent = useHeaderContent();
  const summaryGenerated = change ? parseSummaryGeneratedMetadata(change.events) : null;

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

  const handleRequeueSummary = async () => {
    if (!change) return;
    setRequeueing(true);
    try {
      await requeueSummary(change.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Requeue failed");
    } finally {
      setRequeueing(false);
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

      <LogViewer changeId={change.id} isSummarizing={change.status === "summarizing"} />

      {change.status === "scored" && (
        <div className="flex gap-2">
          <Button variant="outline" onClick={handleRequeueSummary} disabled={requeueing}>
            {requeueing ? "Requeueing..." : "Requeue Summary"}
          </Button>
        </div>
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
                {summaryGenerated?.generator && (
                  <div>
                    <dt className="text-xs text-muted-foreground">Generated By</dt>
                    <dd className="mt-1 space-y-2">
                      <div className="flex flex-wrap gap-1">
                        {summaryGenerated.generator.action_id && (
                          <Badge variant="outline" className="font-mono text-xs">
                            {summaryGenerated.generator.action_id}
                          </Badge>
                        )}
                        {summaryGenerated.generator.prompt_name && (
                          <Badge variant="outline" className="font-mono text-xs">
                            {summaryGenerated.generator.prompt_name}
                          </Badge>
                        )}
                        {summaryGenerated.generator.surfaces?.map((surface) => (
                          <Badge key={surface} variant="secondary" className="text-xs">
                            {surface}
                          </Badge>
                        ))}
                      </div>
                      {summaryGenerated.generator.prompt_hash && (
                        <p className="text-xs text-muted-foreground font-mono break-all">
                          prompt hash: {summaryGenerated.generator.prompt_hash}
                        </p>
                      )}
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

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useAutoAnimate } from "@formkit/auto-animate/react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  XAxis,
  YAxis,
} from "recharts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  fetchLogs,
  fetchRollups,
  fetchTriageRuns,
  type LogEntry,
  type LogQueryResult,
  type LogSummary,
  type TriageRunSummary,
  type WideRollup,
  subscribeToRollupStream,
  subscribeToLogStream,
} from "@/lib/api";

const REQUEST_POLL_INTERVAL_MS = 2000;
const PAGE_SIZE = 100;
const DEFAULT_LOG_LIMIT = 5_000;

type OutcomeFilter = "all" | "ok" | "error";
type ServiceFilter = "all" | string;
type LogLevelFilter = "all" | "info" | "warning" | "error" | "debug";
type LogWindowFilter = "15m" | "1h" | "6h" | "24h";
type StatusClassFilter = "all" | "2xx" | "3xx" | "4xx" | "5xx";
type LogTab = "requests" | "logs";

function formatAgo(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}

function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function minuteLabel(value: string): string {
  return value.slice(11);
}

function outcomeBadge(rollup: WideRollup) {
  const variant =
    rollup.final_outcome === "error"
      ? "destructive"
      : rollup.final_outcome === "ok"
        ? "secondary"
        : "outline";
  const label =
    rollup.final_outcome === "error"
      ? `${rollup.final_status_code ?? "err"}`
      : rollup.final_outcome === "ok"
        ? "ok"
        : "…";
  return <Badge variant={variant as any}>{label}</Badge>;
}

function triageStatusBadge(status: TriageRunSummary["status"]) {
  const tone =
    status === "proposal_ready"
      ? "secondary"
      : status === "failed" || status === "rejected"
        ? "destructive"
        : "outline";
  return <Badge variant={tone as any}>{status}</Badge>;
}

function levelBadge(level: string) {
  if (level === "error") return <Badge variant="destructive">error</Badge>;
  if (level === "warning") return <Badge variant="outline">warning</Badge>;
  if (level === "debug") return <Badge variant="outline">debug</Badge>;
  return <Badge variant="secondary">{level}</Badge>;
}

function statusBadge(status: number | null) {
  if (status === null) return <Badge variant="outline">—</Badge>;
  if (status >= 500) return <Badge variant="destructive">{status}</Badge>;
  if (status >= 400) return <Badge variant="outline">{status}</Badge>;
  return <Badge variant="secondary">{status}</Badge>;
}

function serviceTone(status: number | null): string {
  if (status === null) return "border-border/60";
  if (status >= 500) return "border-destructive/40";
  if (status >= 400) return "border-amber-500/40";
  return "border-emerald-500/30";
}

function topCount(list: Array<{ value: string; count: number }>, key: string): number {
  return list.find((entry) => entry.value === key)?.count ?? 0;
}

function deriveSummaryFromEntries(entries: LogEntry[]): LogSummary {
  const serviceCounts = new Map<string, number>();
  const levelCounts = new Map<string, number>();
  const statusCounts = new Map<string, number>();
  const statusClassCounts = new Map<string, number>();
  const timeline = new Map<string, { minute: string; total: number; errors: number; status5xx: number }>();

  for (const entry of entries) {
    serviceCounts.set(entry.service, (serviceCounts.get(entry.service) ?? 0) + 1);
    levelCounts.set(entry.level, (levelCounts.get(entry.level) ?? 0) + 1);
    if (entry.status !== null) {
      const statusKey = String(entry.status);
      statusCounts.set(statusKey, (statusCounts.get(statusKey) ?? 0) + 1);
      const classKey = `${Math.floor(entry.status / 100)}xx`;
      statusClassCounts.set(classKey, (statusClassCounts.get(classKey) ?? 0) + 1);
    }
    const minute = entry.timestamp.slice(0, 16);
    const bucket = timeline.get(minute) ?? { minute, total: 0, errors: 0, status5xx: 0 };
    bucket.total += 1;
    if (entry.level === "error") bucket.errors += 1;
    if (entry.status !== null && entry.status >= 500) bucket.status5xx += 1;
    timeline.set(minute, bucket);
  }

  const sortCounts = (map: Map<string, number>) =>
    Array.from(map.entries())
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([value, count]) => ({ value, count }));

  return {
    total: entries.length,
    serviceCounts: sortCounts(serviceCounts),
    levelCounts: sortCounts(levelCounts),
    statusCounts: sortCounts(statusCounts),
    statusClassCounts: sortCounts(statusClassCounts),
    timeline: Array.from(timeline.values()).sort((a, b) => a.minute.localeCompare(b.minute)),
  };
}

function mergeRollups(current: WideRollup[], incoming: WideRollup): WideRollup[] {
  const next = [incoming, ...current.filter((item) => item.request_id !== incoming.request_id)];
  next.sort((a, b) => b.rolled_up_at.localeCompare(a.rolled_up_at));
  return next;
}

function statusClassLabel(status: number | null): string {
  if (status === null) return "no-status";
  return `${Math.floor(status / 100)}xx`;
}

function summarizePane(entries: LogEntry[]) {
  let errorCount = 0;
  let status5xxCount = 0;
  for (const entry of entries) {
    if (entry.level === "error") errorCount += 1;
    if (entry.status !== null && entry.status >= 500) status5xxCount += 1;
  }
  return {
    total: entries.length,
    errorCount,
    status5xxCount,
  };
}

function RequestsTab({
  rollups,
  runs,
  loading,
  expanded,
  setExpanded,
  limit,
  setLimit,
}: {
  rollups: WideRollup[] | null;
  runs: TriageRunSummary[] | null;
  loading: boolean;
  expanded: string | null;
  setExpanded: (value: string | null) => void;
  limit: number;
  setLimit: (value: number) => void;
}) {
  const triageByRequestId = useMemo(() => {
    const map = new Map<string, TriageRunSummary>();
    for (const run of runs ?? []) map.set(run.rollup.request_id, run);
    return map;
  }, [runs]);
  const [animatedRollupBody] = useAutoAnimate<HTMLTableSectionElement>({
    duration: 180,
    easing: "ease-out",
  });
  const visibleRollups = rollups ?? [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle>Wide events</CardTitle>
          <span className="text-sm text-muted-foreground">
            {rollups?.length ?? "…"} shown · live stream
            {loading ? " · refreshing…" : ""}
          </span>
        </CardHeader>
        <CardContent>
          {rollups === null && loading ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : visibleRollups.length === 0 ? (
            <p className="text-sm text-muted-foreground">no rollups match these filters yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>time</TableHead>
                  <TableHead>service</TableHead>
                  <TableHead>route</TableHead>
                  <TableHead>outcome</TableHead>
                  <TableHead className="text-right">duration</TableHead>
                  <TableHead>triage</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody ref={animatedRollupBody}>
                {visibleRollups.map((r) => {
                  const triage = triageByRequestId.get(r.request_id);
                  const isOpen = expanded === r.request_id;
                  return (
                    <Fragment key={r.request_id}>
                      <TableRow
                        data-request-id={r.request_id}
                        className="cursor-pointer hover:bg-muted/40"
                        onClick={() => setExpanded(isOpen ? null : r.request_id)}
                      >
                        <TableCell title={r.rolled_up_at}>{formatAgo(r.rolled_up_at)}</TableCell>
                        <TableCell className="font-mono">{r.entry_service}</TableCell>
                        <TableCell className="font-mono text-xs">{r.route_names[0] ?? "—"}</TableCell>
                        <TableCell>{outcomeBadge(r)}</TableCell>
                        <TableCell className="text-right tabular-nums">{r.total_duration_ms}ms</TableCell>
                        <TableCell>{triage ? triageStatusBadge(triage.status) : "—"}</TableCell>
                      </TableRow>
                      {isOpen && (
                        <TableRow>
                          <TableCell colSpan={6} className="bg-muted/20 p-4">
                            <div className="flex flex-col gap-3">
                              <div className="flex flex-wrap gap-2 text-xs">
                                <Badge variant="outline">request_id: {r.request_id}</Badge>
                                <Badge variant="outline">events: {r.event_count}</Badge>
                                <Badge variant="outline">errors: {r.error_count}</Badge>
                                {r.services.map((s) => (
                                  <Badge key={s} variant="secondary">
                                    {s}
                                  </Badge>
                                ))}
                              </div>
                              {r.primary_error && (
                                <pre className="overflow-x-auto rounded border bg-background p-2 text-xs">
                                  {JSON.stringify(r.primary_error, null, 2)}
                                </pre>
                              )}
                              <details>
                                <summary className="cursor-pointer text-sm text-muted-foreground">
                                  events ({r.events.length})
                                </summary>
                                <pre className="mt-2 overflow-x-auto rounded border bg-background p-2 text-xs">
                                  {JSON.stringify(r.events, null, 2)}
                                </pre>
                              </details>
                              {triage && (
                                <details>
                                  <summary className="cursor-pointer text-sm text-muted-foreground">
                                    triage run: {triage.id}
                                  </summary>
                                  <pre className="mt-2 overflow-x-auto rounded border bg-background p-2 text-xs">
                                    {JSON.stringify(triage, null, 2)}
                                  </pre>
                                </details>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          )}
          {rollups && rollups.length >= limit && (
            <div className="mt-4 flex justify-center">
              <Button variant="outline" onClick={() => setLimit(limit + PAGE_SIZE)}>
                Load more
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Triage runs</CardTitle>
        </CardHeader>
        <CardContent>
          {runs === null ? (
            <Skeleton className="h-20 w-full" />
          ) : runs.length === 0 ? (
            <p className="text-sm text-muted-foreground">no triage runs yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>status</TableHead>
                  <TableHead>service</TableHead>
                  <TableHead>error</TableHead>
                  <TableHead>updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell>{triageStatusBadge(run.status)}</TableCell>
                    <TableCell className="font-mono">{run.rollup.entry_service}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {run.plan?.hypothesis
                        ?? run.error
                        ?? (run.rollup.primary_error as { message?: string })?.message
                        ?? "—"}
                    </TableCell>
                    <TableCell title={run.updated_at}>{formatAgo(run.updated_at)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function LogRow({ entry }: { entry: LogEntry }) {
  return (
    <TableRow className={serviceTone(entry.status)}>
      <TableCell className="font-mono text-xs" title={entry.timestamp}>
        {formatClock(entry.timestamp)}
      </TableCell>
      <TableCell className="font-mono text-xs">{entry.service}</TableCell>
      <TableCell>{levelBadge(entry.level)}</TableCell>
      <TableCell>{statusBadge(entry.status)}</TableCell>
      <TableCell className="font-mono text-xs">{entry.method ?? "—"}</TableCell>
      <TableCell className="font-mono text-xs text-muted-foreground">{entry.path ?? entry.logger}</TableCell>
      <TableCell className="max-w-[28rem]">
        <div className="space-y-1">
          <div className="text-sm">{entry.message}</div>
          <div className="flex flex-wrap gap-2 text-[11px] text-muted-foreground">
            {entry.requestId && <span className="font-mono">req {entry.requestId}</span>}
            {entry.responseTimeMs !== null && <span>{entry.responseTimeMs}ms</span>}
          </div>
        </div>
      </TableCell>
      <TableCell className="text-right">
        <details className="inline-block text-left">
          <summary className="cursor-pointer text-xs text-muted-foreground">raw</summary>
          <pre className="mt-2 max-w-[32rem] overflow-x-auto rounded border bg-background p-2 text-[11px]">
            {JSON.stringify(entry.line ?? entry.properties, null, 2)}
          </pre>
        </details>
      </TableCell>
    </TableRow>
  );
}

function LiveLogPane({
  service,
  entries,
  onFocus,
}: {
  service: string;
  entries: LogEntry[];
  onFocus?: () => void;
}) {
  const summary = summarizePane(entries);

  return (
    <Card className="h-full border-border/60 bg-[linear-gradient(180deg,rgba(11,11,13,1),rgba(15,15,18,0.98))]">
      <CardHeader className="flex items-center justify-between gap-3 border-b border-border/60">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary" className="font-mono">
              {service}
            </Badge>
            <Badge variant="outline">{summary.total} lines</Badge>
            <Badge variant="outline">{summary.errorCount} error</Badge>
            <Badge variant={summary.status5xxCount > 0 ? "destructive" : "outline"}>
              {summary.status5xxCount} 5xx
            </Badge>
          </div>
          <CardTitle className="text-base">Live tail</CardTitle>
        </div>
        {onFocus && (
          <Button variant="outline" size="sm" onClick={onFocus}>
            Focus
          </Button>
        )}
      </CardHeader>
      <CardContent className="h-[26rem] p-0">
        <ScrollArea className="h-full">
          <div className="flex flex-col divide-y divide-border/40">
            {entries.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">no lines yet.</div>
            ) : (
              entries.map((entry, index) => (
                <div key={`${entry.timestamp}-${entry.service}-${index}`} className="space-y-2 px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                    <span className="font-mono">{formatClock(entry.timestamp)}</span>
                    {levelBadge(entry.level)}
                    {statusBadge(entry.status)}
                    <Badge variant="outline">{statusClassLabel(entry.status)}</Badge>
                    {entry.method && <span className="font-mono">{entry.method}</span>}
                    {entry.path && <span className="font-mono">{entry.path}</span>}
                    {entry.requestId && <span className="font-mono">req {entry.requestId}</span>}
                    {entry.responseTimeMs !== null && <span>{entry.responseTimeMs}ms</span>}
                  </div>
                  <div className="text-sm leading-6">{entry.message}</div>
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

function LogsTab({
  logs,
  liveConnected,
  loading,
  service,
  setService,
  level,
  setLevel,
  statusClass,
  setStatusClass,
  logger,
  setLogger,
  window,
  setWindow,
  searchInput,
  setSearchInput,
  applySearch,
  clearSearch,
  focusedService,
  setFocusedService,
}: {
  logs: LogQueryResult | null;
  liveConnected: boolean;
  loading: boolean;
  service: ServiceFilter;
  setService: (value: ServiceFilter) => void;
  level: LogLevelFilter;
  setLevel: (value: LogLevelFilter) => void;
  statusClass: StatusClassFilter;
  setStatusClass: (value: StatusClassFilter) => void;
  logger: "all" | "http";
  setLogger: (value: "all" | "http") => void;
  window: LogWindowFilter;
  setWindow: (value: LogWindowFilter) => void;
  searchInput: string;
  setSearchInput: (value: string) => void;
  applySearch: () => void;
  clearSearch: () => void;
  focusedService: string | null;
  setFocusedService: (value: string | null) => void;
}) {
  const topServices = (logs?.summary.serviceCounts ?? []).slice(0, 8);
  const topStatuses = (logs?.summary.statusCounts ?? []).slice(0, 8);
  const totalErrors = topCount(logs?.summary.levelCounts ?? [], "error");
  const total5xx = topCount(logs?.summary.statusClassCounts ?? [], "5xx");
  const total4xx = topCount(logs?.summary.statusClassCounts ?? [], "4xx");
  const knownServices = ["all", ...(logs?.summary.serviceCounts.map((entry) => entry.value) ?? [])];
  const livePanes = useMemo(() => {
    if (!logs) return [];
    const grouped = new Map<string, LogEntry[]>();
    for (const entry of logs.entries) {
      const list = grouped.get(entry.service) ?? [];
      list.push(entry);
      grouped.set(entry.service, list);
    }
    return Array.from(grouped.entries())
      .map(([serviceName, entries]) => ({
        service: serviceName,
        entries,
        total: entries.length,
      }))
      .sort((a, b) => b.total - a.total || a.service.localeCompare(b.service));
  }, [logs]);
  const focusedPane = useMemo(
    () => livePanes.find((pane) => pane.service === focusedService) ?? null,
    [focusedService, livePanes],
  );

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-[2rem] border border-border/60 bg-[radial-gradient(circle_at_top_left,_rgba(232,84,80,0.14),_transparent_38%),linear-gradient(135deg,rgba(11,11,13,1),rgba(18,18,21,0.96))]">
        <div className="space-y-5 px-6 py-8 sm:px-8 sm:py-10">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">loki-backed</Badge>
            <Badge variant={liveConnected ? "secondary" : "outline"}>
              {liveConnected ? "live stream connected" : "live stream reconnecting"}
            </Badge>
            {logs && <Badge variant="outline">{logs.summary.total} entries scanned</Badge>}
          </div>
          <div className="space-y-2">
            <p className="font-mono text-sm uppercase tracking-[0.24em] text-muted-foreground">
              service logs
            </p>
            <h2 className="text-3xl font-semibold tracking-tight text-foreground sm:text-5xl">
              Follow failures across the stack
            </h2>
            <p className="max-w-3xl text-sm leading-6 text-muted-foreground sm:text-base">
              Query Loki across services, narrow to Hono request logs when needed, and break status codes
              out fast enough to spot 5xx spikes before you dig into a single line.
            </p>
          </div>
        </div>
      </section>

      <Card>
        <CardHeader className="space-y-4">
          <CardTitle>Log filters</CardTitle>
          <div className="grid gap-3 lg:grid-cols-6">
            <Select value={service} onValueChange={(value) => setService(value as ServiceFilter)}>
              <SelectTrigger>
                <SelectValue placeholder="service" />
              </SelectTrigger>
              <SelectContent>
                {knownServices.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item === "all" ? "all services" : item}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={level} onValueChange={(value) => setLevel(value as LogLevelFilter)}>
              <SelectTrigger>
                <SelectValue placeholder="level" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">all levels</SelectItem>
                <SelectItem value="info">info</SelectItem>
                <SelectItem value="warning">warning</SelectItem>
                <SelectItem value="error">error</SelectItem>
                <SelectItem value="debug">debug</SelectItem>
              </SelectContent>
            </Select>
            <Select value={statusClass} onValueChange={(value) => setStatusClass(value as StatusClassFilter)}>
              <SelectTrigger>
                <SelectValue placeholder="status class" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">all statuses</SelectItem>
                <SelectItem value="2xx">2xx</SelectItem>
                <SelectItem value="3xx">3xx</SelectItem>
                <SelectItem value="4xx">4xx</SelectItem>
                <SelectItem value="5xx">5xx</SelectItem>
              </SelectContent>
            </Select>
            <Select value={logger} onValueChange={(value) => setLogger(value as "all" | "http")}>
              <SelectTrigger>
                <SelectValue placeholder="logger" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">all loggers</SelectItem>
                <SelectItem value="http">http only</SelectItem>
              </SelectContent>
            </Select>
            <Select value={window} onValueChange={(value) => setWindow(value as LogWindowFilter)}>
              <SelectTrigger>
                <SelectValue placeholder="window" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="15m">15m</SelectItem>
                <SelectItem value="1h">1h</SelectItem>
                <SelectItem value="6h">6h</SelectItem>
                <SelectItem value="24h">24h</SelectItem>
              </SelectContent>
            </Select>
            <div className="flex gap-2">
              <Input
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder="search message, path, request id"
              />
              <Button onClick={applySearch} disabled={loading}>
                Apply
              </Button>
            </div>
          </div>
          <div className="flex justify-end">
            <Button variant="ghost" onClick={clearSearch}>
              Clear search
            </Button>
          </div>
        </CardHeader>
      </Card>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Entries</CardTitle>
          </CardHeader>
          <CardContent className="text-3xl">{logs?.summary.total ?? "—"}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Error logs</CardTitle>
          </CardHeader>
          <CardContent className="text-3xl">{logs ? totalErrors : "—"}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">5xx responses</CardTitle>
          </CardHeader>
          <CardContent className="text-3xl">{logs ? total5xx : "—"}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">4xx responses</CardTitle>
          </CardHeader>
          <CardContent className="text-3xl">{logs ? total4xx : "—"}</CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2">
          <CardHeader>
            <CardTitle className="text-base">Traffic timeline</CardTitle>
          </CardHeader>
          <CardContent>
            {logs === null ? (
              <Skeleton className="h-64 w-full" />
            ) : (
              <ChartContainer
                className="h-64 w-full"
                config={{
                  total: { label: "Total", color: "#e85450" },
                  status5xx: { label: "5xx", color: "#f97316" },
                }}
              >
                <AreaChart data={logs.summary.timeline}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="minute" tickFormatter={minuteLabel} minTickGap={24} />
                  <YAxis allowDecimals={false} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Area
                    type="monotone"
                    dataKey="total"
                    stroke="var(--color-total)"
                    fill="var(--color-total)"
                    fillOpacity={0.18}
                  />
                  <Area
                    type="monotone"
                    dataKey="status5xx"
                    stroke="var(--color-status5xx)"
                    fill="var(--color-status5xx)"
                    fillOpacity={0.16}
                  />
                </AreaChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Status classes</CardTitle>
          </CardHeader>
          <CardContent>
            {logs === null ? (
              <Skeleton className="h-64 w-full" />
            ) : (
              <ChartContainer
                className="h-64 w-full"
                config={{ count: { label: "Count", color: "#fbfbfb" } }}
              >
                <BarChart data={logs.summary.statusClassCounts}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="value" />
                  <YAxis allowDecimals={false} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="count" fill="var(--color-count)" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Top services</CardTitle>
          </CardHeader>
          <CardContent>
            {logs === null ? (
              <Skeleton className="h-56 w-full" />
            ) : (
              <ChartContainer className="h-56 w-full" config={{ count: { label: "Count", color: "#e85450" } }}>
                <BarChart data={topServices}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="value" tick={{ fontSize: 11 }} interval={0} angle={-18} textAnchor="end" height={44} />
                  <YAxis allowDecimals={false} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="count" fill="var(--color-count)" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Top status codes</CardTitle>
          </CardHeader>
          <CardContent>
            {logs === null ? (
              <Skeleton className="h-56 w-full" />
            ) : (
              <ChartContainer className="h-56 w-full" config={{ count: { label: "Count", color: "#fbfbfb" } }}>
                <BarChart data={topStatuses}>
                  <CartesianGrid vertical={false} />
                  <XAxis dataKey="value" />
                  <YAxis allowDecimals={false} />
                  <ChartTooltip content={<ChartTooltipContent />} />
                  <Bar dataKey="count" fill="var(--color-count)" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ChartContainer>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="overflow-hidden border-border/60">
        <CardHeader className="flex items-center justify-between gap-3">
          <div className="space-y-1">
            <CardTitle>Live service panes</CardTitle>
            <p className="text-sm text-muted-foreground">
              One shared SSE stream, split by service in the browser. Live lines stay buffered for the session instead of dropping after the first small page.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>{livePanes.length} services visible</span>
            <span>·</span>
            <span>{logs?.entries.length ?? 0} buffered lines</span>
          </div>
        </CardHeader>
        <CardContent>
          {logs === null ? (
            <Skeleton className="h-[28rem] w-full" />
          ) : livePanes.length === 0 ? (
            <p className="text-sm text-muted-foreground">no live service panes yet.</p>
          ) : livePanes.length === 1 ? (
            <LiveLogPane
              service={livePanes[0].service}
              entries={livePanes[0].entries}
              onFocus={() => setFocusedService(livePanes[0].service)}
            />
          ) : (
            <div className="grid min-h-[30rem] gap-4 lg:grid-cols-2 xl:grid-cols-3">
              {livePanes.map((pane) => (
                <LiveLogPane
                  key={pane.service}
                  service={pane.service}
                  entries={pane.entries}
                  onFocus={() => setFocusedService(pane.service)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle>Recent log lines</CardTitle>
          <span className="text-sm text-muted-foreground">
            {logs?.entries.length ?? "…"} shown · newest first
          </span>
        </CardHeader>
        <CardContent>
          {logs === null ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 8 }).map((_, index) => (
                <Skeleton key={index} className="h-12 w-full" />
              ))}
            </div>
          ) : logs.entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">no logs match these filters yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>time</TableHead>
                  <TableHead>service</TableHead>
                  <TableHead>level</TableHead>
                  <TableHead>status</TableHead>
                  <TableHead>method</TableHead>
                  <TableHead>route</TableHead>
                  <TableHead>message</TableHead>
                  <TableHead className="text-right">detail</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {logs.entries.map((entry, index) => (
                  <LogRow key={`${entry.timestamp}-${entry.service}-${index}`} entry={entry} />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={focusedPane !== null} onOpenChange={(open) => !open && setFocusedService(null)}>
        <DialogContent className="h-[92vh] max-w-[96vw] p-0 sm:max-w-[96vw]">
          {focusedPane && (
            <div className="flex h-full flex-col overflow-hidden">
              <DialogHeader className="border-b border-border/60 px-6 py-4">
                <DialogTitle className="flex items-center gap-2">
                  <Badge variant="secondary" className="font-mono">
                    {focusedPane.service}
                  </Badge>
                  full-screen live tail
                </DialogTitle>
                <DialogDescription>
                  Streaming over SSE and grouped by service. This view keeps the full in-session buffer instead of truncating at a small result cap.
                </DialogDescription>
              </DialogHeader>
              <div className="flex-1 overflow-hidden p-6">
                <LiveLogPane service={focusedPane.service} entries={focusedPane.entries} />
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function TriagePage() {
  const [activeTab, setActiveTab] = useState<LogTab>("requests");
  const [rollups, setRollups] = useState<WideRollup[] | null>(null);
  const [runs, setRuns] = useState<TriageRunSummary[] | null>(null);
  const [requestsLoading, setRequestsLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [service, setService] = useState<ServiceFilter>("all");
  const [outcome, setOutcome] = useState<OutcomeFilter>("all");
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE_SIZE);

  const [logs, setLogs] = useState<LogQueryResult | null>(null);
  const [logError, setLogError] = useState<string | null>(null);
  const [logLoading, setLogLoading] = useState(false);
  const [logService, setLogService] = useState<ServiceFilter>("all");
  const [logLevel, setLogLevel] = useState<LogLevelFilter>("all");
  const [logStatusClass, setLogStatusClass] = useState<StatusClassFilter>("all");
  const [logLogger, setLogLogger] = useState<"all" | "http">("all");
  const [logWindow, setLogWindow] = useState<LogWindowFilter>("1h");
  const [searchInput, setSearchInput] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [liveConnected, setLiveConnected] = useState(false);
  const [streamEntries, setStreamEntries] = useState<LogEntry[]>([]);
  const [focusedService, setFocusedService] = useState<string | null>(null);

  const loadRequests = useCallback(async () => {
    setRequestsLoading(true);
    try {
      const [{ rollups: r }, { runs: t }] = await Promise.all([
        fetchRollups({
          service: service === "all" ? undefined : service,
          outcome: outcome === "all" ? undefined : outcome,
          limit,
        }),
        fetchTriageRuns().catch(() => ({ runs: [] as TriageRunSummary[] })),
      ]);
      setRollups(r);
      setRuns(t);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRequestsLoading(false);
    }
  }, [service, outcome, limit]);

  const loadLogs = useCallback(async () => {
    setLogLoading(true);
    try {
      const next = await fetchLogs({
        service: logService === "all" ? undefined : logService,
        level: logLevel === "all" ? undefined : logLevel,
        statusClass: logStatusClass === "all" ? undefined : logStatusClass,
        logger: logLogger,
        search: appliedSearch || undefined,
        window: logWindow,
        limit: DEFAULT_LOG_LIMIT,
      });
      setLogs(next);
      setStreamEntries(next.entries);
      setLogError(null);
    } catch (err) {
      setLogError(err instanceof Error ? err.message : String(err));
    } finally {
      setLogLoading(false);
    }
  }, [logService, logLevel, logStatusClass, logLogger, appliedSearch, logWindow]);

  useEffect(() => {
    loadRequests();
  }, [loadRequests]);

  useEffect(() => {
    if (activeTab !== "requests") return;
    const unsubscribe = subscribeToRollupStream(
      {
        service: service === "all" ? undefined : service,
        outcome: outcome === "all" ? undefined : outcome,
      },
      (rollup) => {
        setRequestsLoading(false);
        setRollups((current) => mergeRollups(current ?? [], rollup));
        setError(null);
      },
      (message) => {
        setError(message);
      },
    );
    return unsubscribe;
  }, [activeTab, service, outcome]);

  useEffect(() => {
    if (activeTab !== "requests") return;
    const refreshRuns = async () => {
      const { runs: nextRuns } = await fetchTriageRuns().catch(() => ({ runs: [] as TriageRunSummary[] }));
      setRuns(nextRuns);
    };
    void refreshRuns();
    const handle = setInterval(refreshRuns, REQUEST_POLL_INTERVAL_MS);
    return () => clearInterval(handle);
  }, [activeTab]);

  useEffect(() => {
    if (activeTab !== "logs") return;
    void loadLogs();
  }, [activeTab, loadLogs]);

  useEffect(() => {
    if (activeTab !== "logs") return;
    setLiveConnected(false);
    const seen = new Set<string>();
    const unsubscribe = subscribeToLogStream(
      {
        service: logService === "all" ? undefined : logService,
        level: logLevel === "all" ? undefined : logLevel,
        logger: logLogger,
        search: appliedSearch || undefined,
        statusClass: logStatusClass === "all" ? undefined : logStatusClass,
        historyWindow: "5s",
      },
      (entry) => {
        setLiveConnected(true);
        const key = `${entry.timestamp}:${entry.service}:${entry.logger}:${entry.requestId ?? entry.path ?? entry.message}`;
        if (seen.has(key)) return;
        seen.add(key);
        setStreamEntries((current) => {
          const exists = current.some((item) =>
            item.timestamp === entry.timestamp
            && item.service === entry.service
            && item.logger === entry.logger
            && (item.requestId ?? item.path ?? item.message) === (entry.requestId ?? entry.path ?? entry.message)
          );
          if (exists) return current;
          return [entry, ...current].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        });
      },
      (message) => {
        setLiveConnected(false);
        setLogError(message);
      },
    );
    return () => {
      setLiveConnected(false);
      unsubscribe();
    };
  }, [activeTab, logService, logLevel, logLogger, appliedSearch, logStatusClass]);

  const displayLogs = useMemo<LogQueryResult | null>(() => {
    if (!logs) return null;
    return {
      ...logs,
      entries: streamEntries,
      summary: deriveSummaryFromEntries(streamEntries),
    };
  }, [logs, streamEntries]);

  const knownServices = useMemo(() => {
    const set = new Set<string>();
    for (const r of rollups ?? []) set.add(r.entry_service);
    for (const r of logs?.summary.serviceCounts ?? []) set.add(r.value);
    return ["all", ...Array.from(set).sort()];
  }, [rollups, logs]);

  return (
    <div className="flex flex-col gap-6 p-6">
      <header className="space-y-4">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Triage</h1>
            <p className="text-sm text-muted-foreground">
              Requests, wide-events, and now cross-service logs in one operational surface.
            </p>
          </div>
          {activeTab === "requests" && (
            <div className="flex gap-2">
              <Select value={service} onValueChange={(v) => setService(v as ServiceFilter)}>
                <SelectTrigger className="w-40">
                  <SelectValue placeholder="service" />
                </SelectTrigger>
                <SelectContent>
                  {knownServices.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s === "all" ? "all services" : s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Select value={outcome} onValueChange={(v) => setOutcome(v as OutcomeFilter)}>
                <SelectTrigger className="w-32">
                  <SelectValue placeholder="outcome" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">all outcomes</SelectItem>
                  <SelectItem value="ok">ok</SelectItem>
                  <SelectItem value="error">error</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      </header>

      {error && activeTab === "requests" && (
        <Alert variant="destructive">
          <AlertTitle>Unable to load triage requests</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {logError && activeTab === "logs" && (
        <Alert variant="destructive">
          <AlertTitle>Unable to load logs</AlertTitle>
          <AlertDescription>{logError}</AlertDescription>
        </Alert>
      )}

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as LogTab)} className="gap-6">
        <TabsList variant="line">
          <TabsTrigger value="requests">Requests</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
        </TabsList>
        <TabsContent value="requests">
          <RequestsTab
            rollups={rollups}
            runs={runs}
            loading={requestsLoading}
            expanded={expanded}
            setExpanded={setExpanded}
            limit={limit}
            setLimit={setLimit}
          />
        </TabsContent>
        <TabsContent value="logs">
          <LogsTab
            logs={displayLogs}
            liveConnected={liveConnected}
            loading={logLoading}
            service={logService}
            setService={setLogService}
            level={logLevel}
            setLevel={setLogLevel}
            statusClass={logStatusClass}
            setStatusClass={setLogStatusClass}
            logger={logLogger}
            setLogger={setLogLogger}
            window={logWindow}
            setWindow={setLogWindow}
            searchInput={searchInput}
            setSearchInput={setSearchInput}
            applySearch={() => setAppliedSearch(searchInput.trim())}
            clearSearch={() => {
              setSearchInput("");
              setAppliedSearch("");
            }}
            focusedService={focusedService}
            setFocusedService={setFocusedService}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}

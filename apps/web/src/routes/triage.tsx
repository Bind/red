import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
import {
  fetchRollups,
  fetchTriageRuns,
  type TriageRunSummary,
  type WideRollup,
} from "@/lib/api";

const POLL_INTERVAL_MS = 5000;
const PAGE_SIZE = 100;

type OutcomeFilter = "all" | "ok" | "error";
type ServiceFilter = "all" | string;

function formatAgo(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
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

export function TriagePage() {
  const [rollups, setRollups] = useState<WideRollup[] | null>(null);
  const [runs, setRuns] = useState<TriageRunSummary[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [service, setService] = useState<ServiceFilter>("all");
  const [outcome, setOutcome] = useState<OutcomeFilter>("all");
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE_SIZE);

  const load = useCallback(async () => {
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
    }
  }, [service, outcome, limit]);

  useEffect(() => {
    load();
    const handle = setInterval(load, POLL_INTERVAL_MS);
    return () => clearInterval(handle);
  }, [load]);

  const knownServices = useMemo(() => {
    const set = new Set<string>();
    for (const r of rollups ?? []) set.add(r.entry_service);
    return ["all", ...Array.from(set).sort()];
  }, [rollups]);

  const triageByRequestId = useMemo(() => {
    const map = new Map<string, TriageRunSummary>();
    for (const run of runs ?? []) map.set(run.rollup.request_id, run);
    return map;
  }, [runs]);

  return (
    <div className="flex flex-col gap-6 p-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Triage</h1>
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
      </header>

      {error && (
        <Card className="border-destructive">
          <CardContent className="p-4 text-sm text-destructive">{error}</CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="flex items-center justify-between">
          <CardTitle>Wide events</CardTitle>
          <span className="text-sm text-muted-foreground">
            {rollups?.length ?? "…"} shown · polling every {POLL_INTERVAL_MS / 1000}s
          </span>
        </CardHeader>
        <CardContent>
          {rollups === null ? (
            <div className="flex flex-col gap-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : rollups.length === 0 ? (
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
              <TableBody>
                {rollups.map((r) => {
                  const triage = triageByRequestId.get(r.request_id);
                  const isOpen = expanded === r.request_id;
                  return (
                    <>
                      <TableRow
                        key={r.request_id}
                        className="cursor-pointer hover:bg-muted/40"
                        onClick={() =>
                          setExpanded(isOpen ? null : r.request_id)
                        }
                      >
                        <TableCell title={r.rolled_up_at}>{formatAgo(r.rolled_up_at)}</TableCell>
                        <TableCell className="font-mono">{r.entry_service}</TableCell>
                        <TableCell className="font-mono text-xs">
                          {r.route_names[0] ?? "—"}
                        </TableCell>
                        <TableCell>{outcomeBadge(r)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {r.total_duration_ms}ms
                        </TableCell>
                        <TableCell>
                          {triage ? triageStatusBadge(triage.status) : "—"}
                        </TableCell>
                      </TableRow>
                      {isOpen && (
                        <TableRow key={`${r.request_id}-detail`}>
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
                                <pre className="rounded border bg-background p-2 text-xs overflow-x-auto">
                                  {JSON.stringify(r.primary_error, null, 2)}
                                </pre>
                              )}
                              <details>
                                <summary className="cursor-pointer text-sm text-muted-foreground">
                                  events ({r.events.length})
                                </summary>
                                <pre className="mt-2 rounded border bg-background p-2 text-xs overflow-x-auto">
                                  {JSON.stringify(r.events, null, 2)}
                                </pre>
                              </details>
                              {triage && (
                                <details>
                                  <summary className="cursor-pointer text-sm text-muted-foreground">
                                    triage run: {triage.id}
                                  </summary>
                                  <pre className="mt-2 rounded border bg-background p-2 text-xs overflow-x-auto">
                                    {JSON.stringify(triage, null, 2)}
                                  </pre>
                                </details>
                              )}
                            </div>
                          </TableCell>
                        </TableRow>
                      )}
                    </>
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
                    <TableCell className="font-mono">
                      {run.rollup.entry_service}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {run.plan?.hypothesis ??
                        run.error ??
                        (run.rollup.primary_error as { message?: string })?.message ??
                        "—"}
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

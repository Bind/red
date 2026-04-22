import { useEffect, useMemo, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  fetchStatusReport,
  type ServiceStatusProbe,
  type ServiceStatusReport,
} from "@/lib/api";

const POLL_INTERVAL_MS = 5000;

function formatAgo(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ago`;
}

function statusVariant(status: ServiceStatusProbe["status"]) {
  switch (status) {
    case "ok":
      return "secondary";
    case "error":
      return "destructive";
    default:
      return "outline";
  }
}

function serviceTone(status: ServiceStatusProbe["status"]) {
  switch (status) {
    case "ok":
      return "border-emerald-500/30";
    case "error":
      return "border-destructive/50";
    default:
      return "border-border/60";
  }
}

function ServiceCard({ service }: { service: ServiceStatusProbe }) {
  return (
    <Card className={serviceTone(service.status)}>
      <CardHeader className="space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-base uppercase tracking-[0.18em]">
              {service.service}
            </CardTitle>
            <div className="font-mono text-xs text-muted-foreground">
              {service.url ?? "not configured"}
            </div>
          </div>
          <Badge variant={statusVariant(service.status)}>{service.status}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <dl className="grid grid-cols-2 gap-2 text-xs">
          <div>
            <dt className="text-muted-foreground">HTTP</dt>
            <dd className="font-mono">{service.http_status ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Latency</dt>
            <dd className="font-mono">
              {service.latency_ms === null ? "—" : `${service.latency_ms}ms`}
            </dd>
          </div>
          <div className="col-span-2">
            <dt className="text-muted-foreground">Checked</dt>
            <dd>{formatAgo(service.checked_at)}</dd>
          </div>
        </dl>
        {service.error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive">
            {service.error}
          </div>
        )}
        <details className="group rounded-md border border-border/60 bg-background/60">
          <summary className="cursor-pointer list-none px-3 py-2 text-xs text-muted-foreground group-open:border-b group-open:border-border/60">
            raw response
          </summary>
          <pre className="overflow-x-auto p-3 text-xs">
            {JSON.stringify(service.body, null, 2)}
          </pre>
        </details>
      </CardContent>
    </Card>
  );
}

export function StatusPage() {
  const [report, setReport] = useState<ServiceStatusReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const next = await fetchStatusReport();
        if (!cancelled) {
          setReport(next);
          setError(null);
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : "Unable to load service status");
        }
      }
    };

    void load();
    const handle = window.setInterval(() => {
      void load();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, []);

  const grouped = useMemo(() => {
    const services = report?.services ?? [];
    return {
      ok: services.filter((service) => service.status === "ok"),
      error: services.filter((service) => service.status === "error"),
      unconfigured: services.filter((service) => service.status === "unconfigured"),
    };
  }, [report]);

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-[2rem] border border-border/60 bg-gradient-to-br from-card via-card to-card/70">
        <div className="space-y-5 px-6 py-8 sm:px-8 sm:py-10">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={report?.overall_status === "ok" ? "secondary" : "destructive"}>
              {report?.overall_status ?? "loading"}
            </Badge>
            <Badge variant="outline">polling every {POLL_INTERVAL_MS / 1000}s</Badge>
          </div>
          <div className="space-y-2">
            <p className="font-mono text-sm uppercase tracking-[0.24em] text-muted-foreground">
              service status
            </p>
            <h2 className="text-3xl font-semibold tracking-tight text-foreground sm:text-5xl">
              Internal health at a glance
            </h2>
            <p className="max-w-3xl text-sm leading-6 text-muted-foreground sm:text-base">
              This page polls the BFF aggregator and shows the current health response, latency, and
              raw payload for each internal service it can reach.
            </p>
          </div>
        </div>
      </section>

      {error && (
        <Alert variant="destructive">
          <AlertTitle>Unable to load status</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Healthy</CardTitle>
          </CardHeader>
          <CardContent className="text-3xl">{grouped.ok.length}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Failing</CardTitle>
          </CardHeader>
          <CardContent className="text-3xl">{grouped.error.length}</CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Unconfigured</CardTitle>
          </CardHeader>
          <CardContent className="text-3xl">{grouped.unconfigured.length}</CardContent>
        </Card>
      </div>

      {report === null ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, index) => (
            <Skeleton key={index} className="h-64 rounded-2xl" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {report.services.map((service) => (
            <ServiceCard key={service.service} service={service} />
          ))}
        </div>
      )}
    </div>
  );
}

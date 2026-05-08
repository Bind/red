import { useCallback, useEffect, useMemo, useState } from "react";
import { useHeaderContent } from "@/components/layout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import type { DaemonPlaygroundProfile, DaemonPlaygroundRunResult } from "@/lib/api";
import { fetchDaemonPlayground } from "@/lib/api";

const DEFAULT_PROFILES: DaemonPlaygroundProfile[] = [
  {
    id: "memory-embedding",
    name: "Memory + Embeddings",
    mode: "memory_embedding",
    routerProvider: "openrouter",
    routerModel: "openai/text-embedding-3-small",
  },
  {
    id: "librarian-flash",
    name: "Librarian Flash",
    mode: "memory_embedding_librarian",
    routerProvider: "openrouter",
    routerModel: "openai/text-embedding-3-small",
    librarianModel: "deepseek/deepseek-v4-flash",
  },
];

function RoutingGraph({
  files,
}: {
  files: DaemonPlaygroundRunResult["profiles"][number]["scenarios"][number]["evaluation"]["fileDebug"];
}) {
  const width = 760;
  const fileX = 32;
  const routerX = 300;
  const daemonX = 548;
  const topPad = 44;
  const rowGap = 78;
  const daemonGap = 52;
  const daemonNames = [...new Set(files.flatMap((file) => file.selectedDaemons))];
  const daemonBaseY = topPad;
  const height = Math.max(
    topPad + files.length * rowGap + 28,
    daemonBaseY + daemonNames.length * daemonGap + 28,
  );

  const daemonY = new Map(
    daemonNames.map((name, index) => [name, daemonBaseY + index * daemonGap]),
  );

  return (
    <div className="overflow-x-auto rounded border border-border/50 bg-muted/20 p-3">
      <svg viewBox={`0 0 ${width} ${height}`} className="min-w-[760px]">
        <title>Routing graph from changed files through the router to selected daemons</title>
        <text
          x={fileX}
          y={20}
          className="fill-muted-foreground text-[11px] uppercase tracking-[0.2em]"
        >
          files
        </text>
        <text
          x={routerX}
          y={20}
          className="fill-muted-foreground text-[11px] uppercase tracking-[0.2em]"
        >
          router
        </text>
        <text
          x={daemonX}
          y={20}
          className="fill-muted-foreground text-[11px] uppercase tracking-[0.2em]"
        >
          daemons
        </text>

        {files.map((file, index) => {
          const y = topPad + index * rowGap;
          const routerLabel = file.mode === "memory_embedding_librarian" ? "librarian" : file.mode;
          return (
            <g key={file.file}>
              <rect
                x={fileX}
                y={y - 18}
                width="200"
                height="34"
                rx="10"
                className="fill-background stroke-border"
              />
              <text x={fileX + 12} y={y + 2} className="fill-foreground text-[12px] font-mono">
                {file.file}
              </text>

              <rect
                x={routerX}
                y={y - 18}
                width="150"
                height="34"
                rx="10"
                className="fill-background stroke-border"
              />
              <text x={routerX + 12} y={y - 2} className="fill-foreground text-[12px]">
                {routerLabel}
              </text>
              <text x={routerX + 12} y={y + 11} className="fill-muted-foreground text-[10px]">
                {file.selectedDaemons.length} route{file.selectedDaemons.length === 1 ? "" : "s"}
              </text>

              <line
                x1={fileX + 200}
                y1={y - 1}
                x2={routerX}
                y2={y - 1}
                className="stroke-border"
                strokeWidth="1.5"
              />

              {file.selectedDaemons.map((daemon) => {
                const targetY = daemonY.get(daemon);
                if (targetY === undefined) return null;
                return (
                  <line
                    key={`${file.file}-${daemon}`}
                    x1={routerX + 150}
                    y1={y - 1}
                    x2={daemonX}
                    y2={targetY - 1}
                    className="stroke-primary/60"
                    strokeWidth="1.5"
                  />
                );
              })}
            </g>
          );
        })}

        {daemonNames.map((daemon) => {
          const y = daemonY.get(daemon) ?? topPad;
          return (
            <g key={daemon}>
              <rect
                x={daemonX}
                y={y - 18}
                width="180"
                height="34"
                rx="10"
                className="fill-background stroke-border"
              />
              <text x={daemonX + 12} y={y + 2} className="fill-foreground text-[12px] font-mono">
                {daemon}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function scoreTone(finalScore: number): string {
  if (finalScore >= 0.85) return "text-green-500";
  if (finalScore >= 0.6) return "text-foreground";
  if (finalScore >= 0.45) return "text-amber-500";
  return "text-muted-foreground";
}

export function DaemonPlaygroundPage() {
  const setHeaderContent = useHeaderContent();
  const [profiles, setProfiles] = useState<DaemonPlaygroundProfile[]>(DEFAULT_PROFILES);
  const [result, setResult] = useState<DaemonPlaygroundRunResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setHeaderContent(
      <div className="mt-4 space-y-3">
        <div className="flex items-center gap-3">
          <span className="text-lg font-semibold text-foreground">Daemon Playground</span>
          <Badge variant="secondary">local cohort lab</Badge>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Compare routing cohorts across memory, embeddings, and librarian profiles using the
          checked-in training set and real repo files.
        </p>
      </div>,
    );
    return () => setHeaderContent(null);
  }, [setHeaderContent]);

  const runWithProfiles = useCallback(async (nextProfiles: DaemonPlaygroundProfile[]) => {
    setLoading(true);
    setError(null);
    try {
      setResult(await fetchDaemonPlayground(nextProfiles));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Playground run failed");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void runWithProfiles(DEFAULT_PROFILES);
  }, [runWithProfiles]);

  const scenarioNames = useMemo(() => {
    return result?.profiles[0]?.scenarios.map((scenario) => scenario.scenario) ?? [];
  }, [result]);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Profiles</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 lg:grid-cols-3">
            {profiles.map((profile, index) => (
              <Card key={profile.id} className="border-border/60">
                <CardHeader>
                  <CardTitle className="text-sm">{profile.name}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <div className="space-y-2">
                    <Label>Name</Label>
                    <Input
                      value={profile.name}
                      onChange={(event) => {
                        const next = [...profiles];
                        next[index] = { ...profile, name: event.target.value };
                        setProfiles(next);
                      }}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Mode</Label>
                    <Select
                      value={profile.mode}
                      onValueChange={(value) => {
                        const next = [...profiles];
                        next[index] = {
                          ...profile,
                          mode: value as DaemonPlaygroundProfile["mode"],
                        };
                        setProfiles(next);
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="memory_only">memory_only</SelectItem>
                        <SelectItem value="embedding_only">embedding_only</SelectItem>
                        <SelectItem value="memory_embedding">memory_embedding</SelectItem>
                        <SelectItem value="memory_embedding_librarian">
                          memory_embedding_librarian
                        </SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Embedding Provider</Label>
                    <Select
                      value={profile.routerProvider ?? "local"}
                      onValueChange={(value) => {
                        const next = [...profiles];
                        next[index] = {
                          ...profile,
                          routerProvider: value as NonNullable<
                            DaemonPlaygroundProfile["routerProvider"]
                          >,
                        };
                        setProfiles(next);
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="local">local</SelectItem>
                        <SelectItem value="openrouter">openrouter</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label>Embedding Model</Label>
                    <Input
                      value={profile.routerModel ?? ""}
                      placeholder="default"
                      onChange={(event) => {
                        const next = [...profiles];
                        next[index] = {
                          ...profile,
                          routerModel: event.target.value.trim() || undefined,
                        };
                        setProfiles(next);
                      }}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Librarian Model</Label>
                    <Input
                      value={profile.librarianModel ?? ""}
                      placeholder="default"
                      onChange={(event) => {
                        const next = [...profiles];
                        next[index] = {
                          ...profile,
                          librarianModel: event.target.value.trim() || undefined,
                        };
                        setProfiles(next);
                      }}
                    />
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
          <div className="flex items-center gap-3">
            <Button onClick={() => void runWithProfiles(profiles)} disabled={loading}>
              {loading ? "Running..." : "Run playground"}
            </Button>
            {result && (
              <span className="text-sm text-muted-foreground">
                Generated {new Date(result.generatedAt).toLocaleTimeString()}
              </span>
            )}
            {error && <span className="text-sm text-red-500">{error}</span>}
          </div>
        </CardContent>
      </Card>

      {scenarioNames.map((scenarioName) => (
        <section key={scenarioName} className="space-y-4">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-foreground">{scenarioName}</h2>
            <Badge variant="outline">cohort</Badge>
          </div>
          <div className="grid gap-4 xl:grid-cols-3">
            {result?.profiles.map((profileResult) => {
              const scenario = profileResult.scenarios.find(
                (entry) => entry.scenario === scenarioName,
              );
              if (!scenario) return null;
              return (
                <Card key={profileResult.profile.id} className="border-border/60">
                  <CardHeader>
                    <div className="flex items-center justify-between gap-3">
                      <CardTitle className="text-sm">{profileResult.profile.name}</CardTitle>
                      <Badge variant="secondary">{profileResult.profile.mode}</Badge>
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    <RoutingGraph files={scenario.evaluation.fileDebug} />
                    {scenario.evaluation.fileDebug.map((file) => (
                      <div
                        key={file.file}
                        className="space-y-3 rounded border border-border/50 p-3"
                      >
                        <div className="space-y-1">
                          <div className="font-mono text-sm text-foreground">{file.file}</div>
                          <div className="text-xs text-muted-foreground">
                            expected:{" "}
                            {(scenario.expectedByFile[file.file] ?? []).join(", ") || "(none)"}
                          </div>
                          <div className="text-xs text-muted-foreground">
                            selected: {file.selectedDaemons.join(", ") || "(none)"}
                          </div>
                          {file.librarianRationale && (
                            <div className="text-xs text-muted-foreground">
                              librarian: {file.librarianRationale}
                            </div>
                          )}
                        </div>
                        <Separator />
                        <div className="space-y-2">
                          {file.scores.slice(0, 4).map((score) => (
                            <div key={score.daemonName} className="rounded bg-muted/30 p-2 text-xs">
                              <div className="flex items-center justify-between gap-2">
                                <span className="font-mono text-foreground">
                                  {score.daemonName}
                                </span>
                                <span className={scoreTone(score.finalScore)}>
                                  {score.finalScore.toFixed(3)}
                                </span>
                              </div>
                              <div className="mt-1 text-muted-foreground">
                                semantic {score.semanticScore.toFixed(3)} · boost{" "}
                                {score.scoreBoost.toFixed(3)}
                              </div>
                              <div className="mt-1 flex flex-wrap gap-2 text-[11px] text-muted-foreground">
                                <span>dep {String(score.dependencyExact)}</span>
                                <span>checked {String(score.checkedExact)}</span>
                                <span>neighbor {score.pathNeighborScore.toFixed(3)}</span>
                                <span>selected {String(score.selected)}</span>
                              </div>
                            </div>
                          ))}
                        </div>
                        <details className="text-xs text-muted-foreground">
                          <summary className="cursor-pointer select-none">File summary</summary>
                          <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded bg-muted/30 p-3 text-[11px]">
                            {file.fileSummary}
                          </pre>
                        </details>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

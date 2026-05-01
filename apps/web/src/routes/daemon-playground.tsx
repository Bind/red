import { useEffect, useMemo, useState } from "react";
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
import type {
  DaemonPlaygroundProfile,
  DaemonPlaygroundRunResult,
} from "@/lib/api";
import { fetchDaemonPlayground } from "@/lib/api";
import { useHeaderContent } from "@/components/layout";

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
          Compare routing cohorts across memory, embeddings, and librarian profiles using the checked-in
          training set and real repo files.
        </p>
      </div>,
    );
    return () => setHeaderContent(null);
  }, [setHeaderContent]);

  const run = async () => {
    setLoading(true);
    setError(null);
    try {
      setResult(await fetchDaemonPlayground(profiles));
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Playground run failed");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void run();
  }, []);

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
                        next[index] = { ...profile, mode: value as DaemonPlaygroundProfile["mode"] };
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
                        <SelectItem value="memory_embedding_librarian">memory_embedding_librarian</SelectItem>
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
                          routerProvider: value as NonNullable<DaemonPlaygroundProfile["routerProvider"]>,
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
            <Button onClick={() => void run()} disabled={loading}>
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
              const scenario = profileResult.scenarios.find((entry) => entry.scenario === scenarioName);
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
                    {scenario.evaluation.fileDebug.map((file) => (
                      <div key={file.file} className="space-y-3 rounded border border-border/50 p-3">
                        <div className="space-y-1">
                          <div className="font-mono text-sm text-foreground">{file.file}</div>
                          <div className="text-xs text-muted-foreground">
                            expected: {(scenario.expectedByFile[file.file] ?? []).join(", ") || "(none)"}
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
                                <span className="font-mono text-foreground">{score.daemonName}</span>
                                <span className={scoreTone(score.finalScore)}>
                                  {score.finalScore.toFixed(3)}
                                </span>
                              </div>
                              <div className="mt-1 text-muted-foreground">
                                semantic {score.semanticScore.toFixed(3)} · boost {score.scoreBoost.toFixed(3)}
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

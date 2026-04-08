import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fetchHostedRepoSnapshot, type HostedRepoCommit, type HostedRepoSnapshot } from "@/lib/api";

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return "unknown";
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatTimestamp(dateStr: string | null): string {
  if (!dateStr) return "unknown";
  const date = new Date(dateStr);
  if (!Number.isFinite(date.getTime())) return "unknown";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function ReadmePreview({ content }: { content: string }) {
  const preview = useMemo(() => content.split(/\r?\n/).slice(0, 40).join("\n"), [content]);

  return (
    <pre className="overflow-x-auto rounded-xl border border-border/60 bg-black/30 p-4 font-mono text-xs leading-6 text-foreground">
      {preview}
    </pre>
  );
}

function CommitList({ commits }: { commits: HostedRepoCommit[] }) {
  if (commits.length === 0) {
    return <p className="text-sm text-muted-foreground">No commit history is available yet.</p>;
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-border/60">
      {commits.map((commit) => (
        <Link
          to={`/hosted-repo/commits/${commit.sha}`}
          key={commit.sha}
          className="grid gap-2 border-t border-border/60 bg-card/30 px-4 py-2.5 transition-colors first:border-t-0 hover:bg-card/60 focus-visible:bg-card/60 focus-visible:outline-none md:grid-cols-[minmax(0,1fr)_132px] md:items-center"
        >
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="truncate text-sm text-foreground">{commit.message || "No message"}</span>
              <Badge variant="outline" className="h-5 px-1.5 font-mono text-[10px] leading-none">
                {commit.sha.slice(0, 12)}
              </Badge>
            </div>
            <div className="text-[11px] leading-4 text-muted-foreground">
              {commit.author_name || commit.author_email || "unknown author"}
            </div>
          </div>
          <div className="text-[11px] leading-4 text-muted-foreground md:text-right">
            <div className="font-mono">{formatTimestamp(commit.timestamp)}</div>
            <div>{timeAgo(commit.timestamp)}</div>
          </div>
        </Link>
      ))}
    </div>
  );
}

export function HostedRepoPage() {
  const [snapshot, setSnapshot] = useState<HostedRepoSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    fetchHostedRepoSnapshot()
      .then((data) => {
        if (!cancelled) {
          setSnapshot(data);
          setError(null);
        }
      })
      .catch((nextError) => {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : "Unable to load hosted repo");
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (!snapshot && !error) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-40 w-full rounded-3xl" />
        <div className="grid gap-4 md:grid-cols-3">
          <Skeleton className="h-32 rounded-2xl" />
          <Skeleton className="h-32 rounded-2xl" />
          <Skeleton className="h-32 rounded-2xl" />
        </div>
        <Skeleton className="h-96 w-full rounded-3xl" />
      </div>
    );
  }

  if (!snapshot) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Unable to load the hosted repo app</AlertTitle>
        <AlertDescription>{error ?? "Unknown error"}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      <section className="overflow-hidden rounded-[2rem] border border-border/60 bg-gradient-to-br from-card via-card to-card/70">
        <div className="space-y-5 px-6 py-8 sm:px-8 sm:py-10">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="secondary">Hosted repo app</Badge>
            <Badge variant="outline">{snapshot.repo.visibility ?? "private"}</Badge>
          </div>
          <div className="space-y-2">
            <p className="font-mono text-sm uppercase tracking-[0.24em] text-muted-foreground">
              redc hosting redc
            </p>
            <h2 className="text-3xl font-semibold tracking-tight text-foreground sm:text-5xl">
              {snapshot.repo.full_name}
            </h2>
            <p className="max-w-3xl text-sm leading-6 text-muted-foreground sm:text-base">
              This localhost app is pinned to the platform repo itself. The browser only gets a
              curated snapshot; the repo-scoped read credential stays in the BFF.
            </p>
          </div>
        </div>
      </section>

      {!snapshot.availability.reachable && (
        <Alert>
          <AlertTitle>Hosted repo is configured but not readable yet</AlertTitle>
          <AlertDescription>
            {snapshot.availability.error ?? "The BFF could not reach the hosted repo."}
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Default branch</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="font-mono text-2xl text-foreground">{snapshot.repo.default_branch}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Visible branches</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl text-foreground">{snapshot.branches.length}</div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent commits</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl text-foreground">{snapshot.commits.length}</div>
            <p className="mt-2 text-xs text-muted-foreground">
              latest update {timeAgo(snapshot.commits[0]?.timestamp ?? snapshot.fetched_at)}
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Branches</CardTitle>
        </CardHeader>
        <CardContent>
          {snapshot.branches.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No branch data is available yet for {snapshot.repo.full_name}.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Branch</TableHead>
                  <TableHead>Commit</TableHead>
                  <TableHead>Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {snapshot.branches.map((branch) => (
                  <TableRow key={branch.name}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm">{branch.name}</span>
                        {branch.protected && <Badge variant="secondary">protected</Badge>}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="space-y-1">
                        <div className="font-mono text-xs text-muted-foreground">
                          {branch.sha.slice(0, 12)}
                        </div>
                        <div className="text-sm text-foreground">{branch.message || "No message"}</div>
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {timeAgo(branch.timestamp)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>README</CardTitle>
        </CardHeader>
        <CardContent>
          {snapshot.readme ? (
            <div className="space-y-3">
              <p className="font-mono text-xs uppercase tracking-[0.24em] text-muted-foreground">
                {snapshot.readme.path}
              </p>
              <ReadmePreview content={snapshot.readme.content} />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              README content is not available from the hosted repo yet.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>All commits</CardTitle>
        </CardHeader>
        <CardContent>
          <CommitList commits={snapshot.commits} />
        </CardContent>
      </Card>
    </div>
  );
}

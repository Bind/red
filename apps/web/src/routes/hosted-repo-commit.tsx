import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { PatchDiff } from "@pierre/diffs/react";
import { FileTree } from "@pierre/trees/react";
import type { GitStatusEntry } from "@pierre/trees";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  fetchHostedRepoCommitDiff,
  fetchHostedRepoSnapshot,
  type HostedRepoCommit,
} from "@/lib/api";

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

function splitPatchFiles(diff: string): string[] {
  return diff.split(/(?=^diff --git )/m).filter(Boolean);
}

function parseDiffFiles(diff: string): { files: string[]; gitStatus: GitStatusEntry[] } {
  const files: string[] = [];
  const gitStatus: GitStatusEntry[] = [];

  for (const chunk of splitPatchFiles(diff)) {
    const header = chunk.match(/^diff --git (?:a\/|\/dev\/null)(.+?) (?:b\/)(.+)$/m);
    if (!header) continue;
    const path = header[2];
    files.push(path);

    let status: GitStatusEntry["status"] = "modified";
    if (/^new file mode/m.test(chunk) || /^--- \/dev\/null/m.test(chunk)) status = "added";
    else if (/^deleted file mode/m.test(chunk) || /^\+\+\+ \/dev\/null/m.test(chunk)) status = "deleted";
    gitStatus.push({ path, status });
  }

  return { files, gitStatus };
}

function scrollToDiffFile(filename: string) {
  const el = document.querySelector(`[data-diff-file="${filename}"]`);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

export function HostedRepoCommitPage() {
  const { sha = "" } = useParams();
  const [commit, setCommit] = useState<HostedRepoCommit | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    Promise.all([fetchHostedRepoSnapshot(), fetchHostedRepoCommitDiff(sha)])
      .then(([snapshot, patch]) => {
        if (cancelled) return;
        setCommit(snapshot.commits.find((entry) => entry.sha === sha) ?? null);
        setDiff(patch);
        setError(null);
      })
      .catch((nextError) => {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : "Unable to load commit diff");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [sha]);

  const patches = useMemo(() => (diff ? splitPatchFiles(diff) : []), [diff]);
  const { files, gitStatus } = useMemo(
    () => (diff ? parseDiffFiles(diff) : { files: [], gitStatus: [] }),
    [diff],
  );

  useEffect(() => {
    setSelectedFile(files[0] ?? null);
  }, [files]);

  if (!diff && !error) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-32 w-full rounded-3xl" />
        <Skeleton className="h-96 w-full rounded-3xl" />
      </div>
    );
  }

  if (error || !diff) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Unable to load commit diff</AlertTitle>
        <AlertDescription>{error ?? "Unknown error"}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-6">
      <section className="space-y-4 rounded-[2rem] border border-border/60 bg-gradient-to-br from-card via-card to-card/70 px-6 py-8 sm:px-8 sm:py-10">
        <div className="flex flex-wrap items-center gap-3">
          <Badge variant="secondary">Commit</Badge>
          <Badge variant="outline" className="font-mono">
            {sha.slice(0, 12)}
          </Badge>
          <Link className="text-sm text-muted-foreground underline-offset-4 hover:underline" to="/">
            Back to hosted repo
          </Link>
        </div>
        <div className="space-y-2">
          <h2 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
            {commit?.message || "No message"}
          </h2>
          <div className="text-sm text-muted-foreground">
            {commit?.author_name || commit?.author_email || "unknown author"}
            {" · "}
            {formatTimestamp(commit?.timestamp ?? null)}
            {" · "}
            {timeAgo(commit?.timestamp ?? null)}
          </div>
        </div>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Diff</CardTitle>
          <p className="text-sm text-muted-foreground">
            {patches.length} file{patches.length === 1 ? "" : "s"} changed
          </p>
        </CardHeader>
        <CardContent>
          {patches.length > 0 ? (
            <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
              <div className="lg:sticky lg:top-4 lg:w-72 lg:shrink-0">
                <div className="overflow-hidden rounded-xl border border-border bg-card/50">
                  <div className="border-b border-border px-4 py-3">
                    <p className="text-sm font-medium text-foreground">Files</p>
                    <p className="text-xs text-muted-foreground">
                      Jump through this commit using the diffs viewer file tree.
                    </p>
                  </div>
                  <FileTree
                    options={treeOptions}
                    files={files}
                    gitStatus={gitStatus}
                    selectedItems={selectedFile ? [selectedFile] : []}
                    onSelection={(items) => {
                      const next = items.find((item) => !item.isFolder)?.path ?? null;
                      if (!next) return;
                      setSelectedFile(next);
                      scrollToDiffFile(next);
                    }}
                  />
                </div>
              </div>
              <div className="min-w-0 flex-1 space-y-4">
                {patches.map((patch, index) => (
                  <div
                    key={`${sha}-${index}`}
                    data-diff-file={files[index]}
                    className={
                      `overflow-hidden rounded-xl border bg-card/40 transition-colors ${
                        files[index] === selectedFile
                          ? "border-primary/60"
                          : "border-border/60"
                      }`
                    }
                  >
                    <PatchDiff patch={patch} options={diffOptions} />
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">This commit does not include a patch.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

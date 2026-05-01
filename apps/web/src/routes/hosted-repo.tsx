import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { FileTree } from "@pierre/trees/react";
import { MarkdownContent } from "@/components/markdown-content";
import { GitBranch, GitCommit, Clock, ShieldCheck, FileText, Code, Check, Copy } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  fetchHostedRepoSnapshot,
  fetchHostedRepoCommitDiff,
  fetchHostedRepoFile,
  type HostedRepoSnapshot,
} from "@/lib/api";

const treeOptions = {
  flattenEmptyDirectories: true,
  unsafeCSS: `
    :host {
      --trees-bg-override: var(--background);
      --trees-fg-override: var(--foreground);
      --trees-accent-override: var(--primary);
      --trees-font-family-override: 'Geist Mono Variable', monospace;
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

function parseDiffFiles(diff: string): string[] {
  return diff.split(/(?=^diff --git )/m).filter(Boolean).flatMap((chunk) => {
    const header = chunk.match(/^diff --git (?:a\/|\/dev\/null)(.+?) (?:b\/)(.+)$/m);
    return header ? [header[2]] : [];
  });
}

function ClonePopover({ owner, repo }: { owner: string; repo: string }) {
  const [copied, setCopied] = useState<string | null>(null);

  const urls = {
    https: `https://github.com/${owner}/${repo}.git`,
    ssh: `git@github.com:${owner}/${repo}.git`,
    cli: `gh repo clone ${owner}/${repo}`,
  };

  function copy(key: string, value: string) {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(null), 2000);
    });
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2.5 text-xs">
          <Code className="h-3.5 w-3.5" />
          Clone
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-0 p-0">
        <div className="border-b border-border px-3 py-2">
          <p className="text-xs font-medium text-foreground">Clone repository</p>
        </div>
        <div className="space-y-1 p-2">
          {(["https", "ssh", "cli"] as const).map((key) => (
            <div key={key} className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-muted/40">
              <span className="w-10 shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {key}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">
                {urls[key]}
              </span>
              <button
                type="button"
                onClick={() => copy(key, urls[key])}
                className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
              >
                {copied === key
                  ? <Check className="h-3.5 w-3.5 text-primary" />
                  : <Copy className="h-3.5 w-3.5" />
                }
              </button>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export function HostedRepoPage() {
  const { owner = "", repo = "" } = useParams();
  const repoId = owner && repo ? `${owner}/${repo}` : "";
  const [snapshot, setSnapshot] = useState<HostedRepoSnapshot | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    if (!repoId) { setError("Missing repo id"); return () => { cancelled = true; }; }

    fetchHostedRepoSnapshot(repoId)
      .then((data) => {
        if (cancelled) return;
        setSnapshot(data);
        setError(null);
        const latestSha = data.commits[0]?.sha;
        if (latestSha) {
          return fetchHostedRepoCommitDiff(latestSha, repoId).then((patch) => {
            if (!cancelled) setDiff(patch);
          }).catch(() => {});
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Unable to load repo");
      });

    return () => { cancelled = true; };
  }, [repoId]);

  const files = useMemo(() => (diff ? parseDiffFiles(diff) : []), [diff]);

  useEffect(() => {
    if (!selectedFile) { setFileContent(null); return; }
    let cancelled = false;
    setFileLoading(true);
    setFileContent(null);
    const activeBranch = snapshot?.repo.default_branch;
    fetchHostedRepoFile(selectedFile, activeBranch, repoId)
      .then((content) => { if (!cancelled) { setFileContent(content); setFileLoading(false); } })
      .catch(() => { if (!cancelled) { setFileContent(null); setFileLoading(false); } });
    return () => { cancelled = true; };
  }, [selectedFile, repoId, snapshot?.repo.default_branch]);

  if (!snapshot && !error) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-full rounded-md" />
        <div className="flex gap-4">
          <Skeleton className="h-[480px] w-[280px] shrink-0 rounded-md" />
          <Skeleton className="h-[480px] flex-1 rounded-md" />
        </div>
      </div>
    );
  }

  if (!snapshot) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Unable to load repo</AlertTitle>
        <AlertDescription>{error ?? "Unknown error"}</AlertDescription>
      </Alert>
    );
  }

  const activeBranch = selectedBranch ?? snapshot.repo.default_branch;
  const activeBranchData = snapshot.branches.find((b) => b.name === activeBranch);
  const latestCommit = snapshot.commits[0];

  return (
    <div className="space-y-3">
      {!snapshot.availability.reachable && (
        <Alert>
          <AlertTitle>Repo not reachable</AlertTitle>
          <AlertDescription>
            {snapshot.availability.error ?? "The BFF could not reach the hosted repo."}
          </AlertDescription>
        </Alert>
      )}

      {/* Top bar */}
      <div className="bg-depth flex items-center gap-2 rounded-md border border-border px-3 py-1.5">
        <Select value={activeBranch} onValueChange={setSelectedBranch}>
          <SelectTrigger className="h-7 w-auto gap-1.5 border-none bg-transparent px-1.5 text-xs shadow-none focus:ring-0">
            <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {snapshot.branches.map((b) => (
              <SelectItem key={b.name} value={b.name} className="font-mono text-xs">
                {b.name}
                {b.protected && (
                  <ShieldCheck className="ml-1.5 inline h-3 w-3 text-muted-foreground" />
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <span className="text-muted-foreground/40">·</span>
        <span className="font-mono text-xs text-foreground">{snapshot.repo.full_name}</span>

        {activeBranchData && (
          <>
            <span className="text-muted-foreground/40">·</span>
            <Link
              to={`/bind/${owner}/${repo}/commits/${activeBranchData.sha}`}
              className="flex items-center gap-1 transition-colors hover:text-foreground"
            >
              <GitCommit className="h-3 w-3 text-muted-foreground" />
              <span className="font-mono text-[11px] text-muted-foreground">
                {activeBranchData.sha.slice(0, 7)}
              </span>
            </Link>
            <span className="max-w-sm truncate text-[11px] text-muted-foreground">
              {activeBranchData.message}
            </span>
          </>
        )}

        <div className="ml-auto flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Clock className="h-3 w-3" />
            <span>{snapshot.commits.length} commits</span>
            <span className="text-muted-foreground/40">·</span>
            <span>updated {timeAgo(latestCommit?.timestamp ?? snapshot.fetched_at)}</span>
          </div>
          <ClonePopover owner={snapshot.repo.owner} repo={snapshot.repo.name} />
        </div>
      </div>

      {/* Two-column layout */}
      <div className="flex gap-4 items-start">
        {/* Left: file tree */}
        <div className="w-[280px] shrink-0 overflow-hidden rounded-md border border-border">
          <div className="bg-depth-subtle flex items-center gap-2 border-b border-border px-3 py-2">
            {latestCommit ? (
              <Link
                to={`/bind/${owner}/${repo}/commits/${latestCommit.sha}`}
                className="font-mono text-[10px] text-muted-foreground transition-colors hover:text-foreground"
              >
                {latestCommit.sha.slice(0, 7)}
              </Link>
            ) : null}
            <span className="truncate text-[11px] text-muted-foreground">
              {latestCommit?.message ?? ""}
            </span>
          </div>

          {/* README entry */}
          <button
            type="button"
            onClick={() => setSelectedFile(null)}
            className={`flex w-full items-center gap-2 border-b border-border/50 px-3 py-2 text-left text-xs transition-colors hover:bg-muted/40 ${
              selectedFile === null ? "bg-muted/40 text-foreground" : "text-muted-foreground"
            }`}
          >
            <FileText className="h-3.5 w-3.5 shrink-0" />
            {snapshot.readme?.path ?? "README.md"}
          </button>

          {files.length > 0 ? (
            <FileTree
              options={treeOptions}
              files={files}
              selectedItems={selectedFile ? [selectedFile] : []}
              onSelection={(items) => {
                const next = items.find((item) => !item.isFolder)?.path ?? null;
                if (next) setSelectedFile(next);
              }}
            />
          ) : (
            <div className="px-3 py-4 text-xs text-muted-foreground">
              {diff === null ? "Loading files…" : "No files in latest commit."}
            </div>
          )}
        </div>

        {/* Right: file content or README */}
        <div className="min-w-0 flex-1 overflow-hidden rounded-md border border-border">
          <div className="bg-depth-subtle flex items-center gap-2 border-b border-border px-3 py-2">
            <span className="font-mono text-xs font-medium">
              {selectedFile ?? snapshot.readme?.path ?? "README.md"}
            </span>
            <Badge variant="outline" className="ml-auto h-4 px-1.5 text-[10px]">
              {activeBranch}
            </Badge>
          </div>

          {selectedFile ? (
            fileLoading ? (
              <div className="p-6">
                <Skeleton className="mb-2 h-4 w-3/4" />
                <Skeleton className="mb-2 h-4 w-1/2" />
                <Skeleton className="h-4 w-2/3" />
              </div>
            ) : fileContent !== null ? (
              fileContent.endsWith(".md") || selectedFile.endsWith(".md") ? (
                <MarkdownContent content={fileContent} />
              ) : (
                <pre className="overflow-x-auto p-6 font-mono text-xs leading-relaxed text-foreground">
                  {fileContent}
                </pre>
              )
            ) : (
              <p className="p-6 text-xs text-muted-foreground">Unable to load file content.</p>
            )
          ) : (
            snapshot.readme ? (
              <MarkdownContent content={snapshot.readme.content} />
            ) : (
              <p className="p-6 text-xs text-muted-foreground">No README available.</p>
            )
          )}
        </div>
      </div>
    </div>
  );
}

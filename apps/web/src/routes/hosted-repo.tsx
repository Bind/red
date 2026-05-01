import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { FileTree } from "@pierre/trees/react";
import { MarkdownContent } from "@/components/markdown-content";
import {
  GitBranch, GitCommit, Clock, ShieldCheck, FileText,
  Code, Check, Copy, ChevronDown, ChevronRight, Bot, Database,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  fetchHostedRepoSnapshot, fetchHostedRepoCommitDiff, fetchHostedRepoFile,
  fetchHostedRepoTree, fetchReviewQueue, fetchDaemonMemory,
  type HostedRepoSnapshot, type Change, type DaemonMemory,
} from "@/lib/api";

// ─── options ────────────────────────────────────────────────────────────────

const treeOptions = {
  flattenEmptyDirectories: true,
  unsafeCSS: `
    :host {
      --trees-bg-override: var(--background);
      --trees-bg-muted-override: var(--muted);
      --trees-fg-override: var(--foreground);
      --trees-accent-override: var(--primary);
      --trees-font-family-override: 'Geist Mono Variable', monospace;
      --trees-font-size-override: 13px;
    }
  `,
};

// ─── mock issues ────────────────────────────────────────────────────────────

interface MockIssue {
  id: number;
  title: string;
  status: "open" | "closed";
  label: string;
  createdAt: string;
}

const MOCK_ISSUES: MockIssue[] = [
  { id: 1, title: "Triage view doesn't show log lines for long-running daemons", status: "open", label: "bug", createdAt: "2026-04-28T10:00:00Z" },
  { id: 2, title: "Branch picker should re-fetch commits when branch changes", status: "open", label: "enhancement", createdAt: "2026-04-27T14:30:00Z" },
  { id: 3, title: "Add file content endpoint for non-markdown files", status: "closed", label: "enhancement", createdAt: "2026-04-25T09:00:00Z" },
  { id: 4, title: "Daemon memory view should surface stale tracked subjects", status: "open", label: "feature", createdAt: "2026-04-24T16:00:00Z" },
  { id: 5, title: "Review queue filter by confidence level", status: "open", label: "feature", createdAt: "2026-04-23T11:00:00Z" },
];

// ─── helpers ─────────────────────────────────────────────────────────────────

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return "unknown";
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (!Number.isFinite(seconds) || seconds < 0) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function parseDiffFiles(diff: string): string[] {
  return diff.split(/(?=^diff --git )/m).filter(Boolean).flatMap((chunk) => {
    const header = chunk.match(/^diff --git (?:a\/|\/dev\/null)(.+?) (?:b\/)(.+)$/m);
    return header ? [header[2]] : [];
  });
}

// ─── clone popover ───────────────────────────────────────────────────────────

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
          <Code className="h-3.5 w-3.5" />Clone
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 gap-0 p-0">
        <div className="border-b border-border px-3 py-2">
          <p className="text-xs font-medium">Clone repository</p>
        </div>
        <div className="space-y-1 p-2">
          {(["https", "ssh", "cli"] as const).map((key) => (
            <div key={key} className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-muted/40">
              <span className="w-10 shrink-0 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{key}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-foreground">{urls[key]}</span>
              <button type="button" onClick={() => copy(key, urls[key])}
                className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:text-foreground">
                {copied === key ? <Check className="h-3.5 w-3.5 text-primary" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

// ─── pull requests tab ───────────────────────────────────────────────────────

const confidenceColors: Record<string, string> = {
  safe: "text-green-500",
  needs_review: "text-yellow-500",
  critical: "text-red-500",
};

function PullRequestsTab({ repoFullName }: { repoFullName: string }) {
  const [changes, setChanges] = useState<Change[] | null>(null);

  useEffect(() => {
    fetchReviewQueue().then((all) =>
      setChanges(all.filter((c) => c.repo === repoFullName))
    ).catch(() => setChanges([]));
  }, [repoFullName]);

  if (!changes) {
    return <div className="space-y-2 p-4">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-14 rounded-md" />)}</div>;
  }

  if (changes.length === 0) {
    return <p className="p-6 text-sm text-muted-foreground">No pull requests in the review queue for this repo.</p>;
  }

  return (
    <div className="divide-y divide-border">
      {changes.map((c) => (
        <Link key={c.id} to={`/changes/${c.id}`}
          className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-muted/30">
          <GitCommit className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm text-foreground">{c.branch}</span>
              {c.confidence && (
                <span className={`text-xs font-medium ${confidenceColors[c.confidence] ?? ""}`}>
                  {c.confidence.replace("_", " ")}
                </span>
              )}
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {c.base_branch} ← {c.branch} · {c.status.replace(/_/g, " ")} · {timeAgo(c.created_at)}
            </div>
            {c.summary && (
              <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{c.summary}</p>
            )}
          </div>
          {c.diff_stats && (
            <div className="shrink-0 text-right text-[11px] text-muted-foreground">
              <span className="text-green-500">+{c.diff_stats.additions}</span>
              {" / "}
              <span className="text-red-500">-{c.diff_stats.deletions}</span>
            </div>
          )}
        </Link>
      ))}
    </div>
  );
}

// ─── issues tab ──────────────────────────────────────────────────────────────

const labelColors: Record<string, string> = {
  bug: "text-red-400 bg-red-400/10",
  enhancement: "text-blue-400 bg-blue-400/10",
  feature: "text-purple-400 bg-purple-400/10",
};

function IssuesTab() {
  const [filter, setFilter] = useState<"open" | "closed">("open");
  const visible = MOCK_ISSUES.filter((i) => i.status === filter);

  return (
    <div>
      <div className="flex items-center gap-3 border-b border-border px-4 py-2">
        {(["open", "closed"] as const).map((f) => (
          <button key={f} type="button" onClick={() => setFilter(f)}
            className={`text-xs transition-colors ${filter === f ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
            {f.charAt(0).toUpperCase() + f.slice(1)}{" "}
            <span className="text-muted-foreground">({MOCK_ISSUES.filter((i) => i.status === f).length})</span>
          </button>
        ))}
        <Badge variant="secondary" className="ml-auto text-[10px]">mock data</Badge>
      </div>
      {visible.length === 0 ? (
        <p className="p-6 text-sm text-muted-foreground">No {filter} issues.</p>
      ) : (
        <div className="divide-y divide-border">
          {visible.map((issue) => (
            <div key={issue.id} className="flex items-start gap-3 px-4 py-3">
              <span className="mt-0.5 text-xs text-muted-foreground">#{issue.id}</span>
              <div className="min-w-0 flex-1">
                <span className="text-sm text-foreground">{issue.title}</span>
                <div className="mt-1 flex items-center gap-2">
                  <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${labelColors[issue.label] ?? "text-muted-foreground bg-muted"}`}>
                    {issue.label}
                  </span>
                  <span className="text-[11px] text-muted-foreground">opened {timeAgo(issue.createdAt)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── daemons tab ─────────────────────────────────────────────────────────────

function DaemonMemoryView({ name, repoId }: { name: string; repoId: string }) {
  const [memory, setMemory] = useState<DaemonMemory | null | "loading">("loading");
  const [expandedSubject, setExpandedSubject] = useState<string | null>(null);

  useEffect(() => {
    fetchDaemonMemory(name, repoId).then(setMemory).catch(() => setMemory(null));
  }, [name, repoId]);

  if (memory === "loading") {
    return <div className="space-y-2 p-4"><Skeleton className="h-4 w-2/3" /><Skeleton className="h-4 w-1/2" /></div>;
  }

  if (!memory) {
    return <p className="px-4 py-3 text-xs text-muted-foreground">No memory recorded yet for this daemon.</p>;
  }

  const trackedEntries = Object.values(memory.tracked ?? {});
  const orderedTrackedEntries = [...trackedEntries].sort((a, b) => a.subject.localeCompare(b.subject));
  const allTrackedFiles = Array.from(
    new Set(trackedEntries.flatMap((e) => e.depends_on))
  ).sort();

  return (
    <div className="space-y-4 px-4 py-3">
      {memory.lastRun?.summary && (
        <p className="text-xs text-muted-foreground">{memory.lastRun.summary}</p>
      )}

      {allTrackedFiles.length > 0 && (
        <div>
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Tracked files ({allTrackedFiles.length})
          </p>
          <div className="space-y-0.5">
            {allTrackedFiles.map((f) => (
              <div key={f} className="flex items-center gap-1.5">
                <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
                <span className="font-mono text-[11px] text-foreground">{f}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {trackedEntries.length > 0 && (
        <div>
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Subjects ({trackedEntries.length})
          </p>
          <div className="space-y-1">
            {orderedTrackedEntries.map((entry) => {
              const open = expandedSubject === entry.subject;
              return (
                <div key={entry.subject} className="overflow-hidden rounded-sm border border-border/50">
                  <button
                    type="button"
                    onClick={() => setExpandedSubject(open ? null : entry.subject)}
                    className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left transition-colors hover:bg-muted/30"
                  >
                    <Database className="h-3 w-3 shrink-0 text-muted-foreground" />
                    <span className="text-xs text-foreground">{entry.subject}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground">
                      {entry.depends_on.length} file{entry.depends_on.length !== 1 ? "s" : ""}
                    </span>
                    {open ? (
                      <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
                    ) : (
                      <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
                    )}
                  </button>

                  {open && (
                    <div className="space-y-3 border-t border-border/50 bg-muted/10 px-3 py-2.5">
                      <div className="grid gap-1 text-[11px] text-muted-foreground">
                        <div>
                          <span className="font-medium text-foreground">Checked</span>
                          {" · "}
                          {timeAgo(entry.checked_at)}
                        </div>
                        <div>
                          <span className="font-medium text-foreground">Source run</span>
                          {" · "}
                          <span className="font-mono">{entry.source_run_id}</span>
                        </div>
                      </div>

                      <div>
                        <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                          Fact payload
                        </p>
                        <pre className="overflow-x-auto rounded-sm border border-border/50 bg-background/70 p-2 font-mono text-[11px] leading-relaxed text-foreground">
                          {JSON.stringify(entry.fact, null, 2)}
                        </pre>
                      </div>

                      {entry.depends_on.length > 0 && (
                        <div>
                          <p className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            Depends on
                          </p>
                          <div className="space-y-0.5">
                            {entry.depends_on.map((file) => (
                              <div key={file} className="flex items-center gap-1.5">
                                <FileText className="h-3 w-3 shrink-0 text-muted-foreground" />
                                <span className="font-mono text-[11px] text-foreground">{file}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {memory.lastRun?.findings && memory.lastRun.findings.length > 0 && (
        <div>
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            Last run findings
          </p>
          <div className="space-y-1">
            {memory.lastRun.findings.map((f, i) => (
              <div key={i} className="flex items-start gap-2 text-xs">
                <span className={`mt-0.5 shrink-0 font-medium ${
                  f.status === "ok" ? "text-green-500" :
                  f.status === "healed" ? "text-yellow-500" :
                  f.status === "violation_persists" ? "text-red-500" : "text-muted-foreground"
                }`}>{f.status.replace(/_/g, " ")}</span>
                <span className="text-muted-foreground">{f.invariant}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="text-[10px] text-muted-foreground/60">
        commit {memory.commit?.slice(0, 7) ?? "unknown"} · updated {timeAgo(memory.updatedAt)}
      </p>
    </div>
  );
}

interface RepoDaemon {
  name: string;
  path: string;
}

function DaemonsTab({ repoId, defaultBranch }: { repoId: string; defaultBranch: string }) {
  const [daemons, setDaemons] = useState<RepoDaemon[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    fetchHostedRepoTree(defaultBranch, repoId)
      .then((files) => {
        const found = files
          .filter((f) => f.endsWith(".daemon.md"))
          .map((path) => {
            const filename = path.split("/").pop() ?? path;
            const name = filename.replace(/\.daemon\.md$/, "");
            return { name, path };
          });
        setDaemons(found);
      })
      .catch(() => setDaemons([]));
  }, [repoId, defaultBranch]);

  if (!daemons) {
    return <div className="space-y-2 p-4">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-12 rounded-md" />)}</div>;
  }

  if (daemons.length === 0) {
    return <p className="p-6 text-sm text-muted-foreground">No <code className="font-mono text-xs">*.daemon.md</code> files found in this repo.</p>;
  }

  return (
    <div className="divide-y divide-border">
      {daemons.map((d) => (
        <div key={d.path}>
          <button type="button" onClick={() => setExpanded(expanded === d.path ? null : d.path)}
            className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/30">
            <Bot className="h-4 w-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <div className="text-sm text-foreground">{d.name}</div>
              <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{d.path}</div>
            </div>
            {expanded === d.path
              ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
          </button>
          {expanded === d.path && (
            <div className="border-t border-border/50 bg-muted/20">
              <DaemonMemoryView name={d.name} repoId={repoId} />
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ─── CI tab (stub) ────────────────────────────────────────────────────────────

function CITab() {
  return (
    <div className="p-6 text-center">
      <p className="text-sm text-muted-foreground">CI integration coming soon.</p>
    </div>
  );
}

// ─── code tab ────────────────────────────────────────────────────────────────

function CodeTab({
  snapshot, owner, repo, repoId, diff,
}: {
  snapshot: HostedRepoSnapshot;
  owner: string;
  repo: string;
  repoId: string;
  diff: string | null;
}) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [fileLoading, setFileLoading] = useState(false);

  const files = useMemo(() => (diff ? parseDiffFiles(diff) : []), [diff]);

  const activeBranch = snapshot.repo.default_branch;

  useEffect(() => {
    if (!selectedFile) { setFileContent(null); return; }
    let cancelled = false;
    setFileLoading(true);
    setFileContent(null);
    fetchHostedRepoFile(selectedFile, activeBranch, repoId)
      .then((c) => { if (!cancelled) { setFileContent(c); setFileLoading(false); } })
      .catch(() => { if (!cancelled) { setFileContent(null); setFileLoading(false); } });
    return () => { cancelled = true; };
  }, [selectedFile, repoId, activeBranch]);

  const latestCommit = snapshot.commits[0];

  return (
    <div className="flex gap-0 items-start">
      {/* Left: file tree */}
      <div className="w-[260px] shrink-0 border-r border-border">
        <div className="bg-depth-subtle flex items-center gap-2 border-b border-border px-3 py-2">
          {latestCommit ? (
            <Link to={`/bind/${owner}/${repo}/commits/${latestCommit.sha}`}
              className="font-mono text-[10px] text-muted-foreground transition-colors hover:text-foreground">
              {latestCommit.sha.slice(0, 7)}
            </Link>
          ) : null}
          <span className="truncate text-[11px] text-muted-foreground">{latestCommit?.message ?? ""}</span>
        </div>
        <button type="button" onClick={() => setSelectedFile(null)}
          className={`flex w-full items-center gap-2 border-b border-border/50 px-3 py-2 text-left text-xs transition-colors hover:bg-muted/40 ${selectedFile === null ? "bg-muted/40 text-foreground" : "text-muted-foreground"}`}>
          <FileText className="h-3.5 w-3.5 shrink-0" />
          {snapshot.readme?.path ?? "README.md"}
        </button>
        {files.length > 0 ? (
          <FileTree options={treeOptions} files={files}
            selectedItems={selectedFile ? [selectedFile] : []}
            onSelection={(items) => {
              const next = items.find((item) => !item.isFolder)?.path ?? null;
              if (next) setSelectedFile(next);
            }} />
        ) : (
          <div className="px-3 py-4 text-xs text-muted-foreground">
            {diff === null ? "Loading files…" : "No files in latest commit."}
          </div>
        )}
      </div>

      {/* Right: file content or README */}
      <div className="min-w-0 flex-1 overflow-hidden">
        <div className="bg-depth-subtle flex items-center gap-2 border-b border-border px-3 py-2">
          <span className="font-mono text-xs font-medium">
            {selectedFile ?? snapshot.readme?.path ?? "README.md"}
          </span>
          <Badge variant="outline" className="ml-auto h-4 px-1.5 text-[10px]">{activeBranch}</Badge>
        </div>
        {selectedFile ? (
          fileLoading ? (
            <div className="p-6"><Skeleton className="mb-2 h-4 w-3/4" /><Skeleton className="mb-2 h-4 w-1/2" /><Skeleton className="h-4 w-2/3" /></div>
          ) : fileContent !== null ? (
            selectedFile.endsWith(".md") ? (
              <MarkdownContent content={fileContent} />
            ) : (
              <pre className="overflow-x-auto p-6 font-mono text-xs leading-relaxed text-foreground">{fileContent}</pre>
            )
          ) : (
            <p className="p-6 text-xs text-muted-foreground">Unable to load file content.</p>
          )
        ) : (
          snapshot.readme
            ? <MarkdownContent content={snapshot.readme.content} />
            : <p className="p-6 text-xs text-muted-foreground">No README available.</p>
        )}
      </div>
    </div>
  );
}

// ─── page ─────────────────────────────────────────────────────────────────────

export function HostedRepoPage() {
  const { owner = "", repo = "" } = useParams();
  const repoId = owner && repo ? `${owner}/${repo}` : "";
  const [snapshot, setSnapshot] = useState<HostedRepoSnapshot | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedBranch, setSelectedBranch] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!repoId) { setError("Missing repo id"); return () => { cancelled = true; }; }
    fetchHostedRepoSnapshot(repoId)
      .then((data) => {
        if (cancelled) return;
        setSnapshot(data);
        setError(null);
        const sha = data.commits[0]?.sha;
        if (sha) fetchHostedRepoCommitDiff(sha, repoId).then((p) => { if (!cancelled) setDiff(p); }).catch(() => {});
      })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : "Unable to load repo"); });
    return () => { cancelled = true; };
  }, [repoId]);

  if (!snapshot && !error) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-8 w-full rounded-md" />
        <Skeleton className="h-[480px] w-full rounded-md" />
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
          <AlertDescription>{snapshot.availability.error ?? "The BFF could not reach the hosted repo."}</AlertDescription>
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
                {b.protected && <ShieldCheck className="ml-1.5 inline h-3 w-3 text-muted-foreground" />}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <span className="text-muted-foreground/40">·</span>
        <span className="font-mono text-xs text-foreground">{snapshot.repo.full_name}</span>

        {activeBranchData && (
          <>
            <span className="text-muted-foreground/40">·</span>
            <Link to={`/bind/${owner}/${repo}/commits/${activeBranchData.sha}`}
              className="flex items-center gap-1 transition-colors hover:text-foreground">
              <GitCommit className="h-3 w-3 text-muted-foreground" />
              <span className="font-mono text-[11px] text-muted-foreground">{activeBranchData.sha.slice(0, 7)}</span>
            </Link>
            <span className="max-w-sm truncate text-[11px] text-muted-foreground">{activeBranchData.message}</span>
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

      {/* Tabs */}
      <Tabs defaultValue="code">
        <TabsList className="h-8 rounded-none border-b border-border bg-transparent px-0 w-full justify-start gap-0">
          {(["code", "pull-requests", "issues", "ci", "daemons"] as const).map((t) => (
            <TabsTrigger key={t} value={t}
              className="h-8 rounded-none border-b-2 border-transparent px-3 text-xs data-[state=active]:border-primary data-[state=active]:bg-transparent data-[state=active]:shadow-none">
              {t === "pull-requests" ? "Pull Requests" : t === "ci" ? "CI" : t.charAt(0).toUpperCase() + t.slice(1)}
            </TabsTrigger>
          ))}
        </TabsList>

        <div className="overflow-hidden rounded-b-md rounded-tr-md border border-t-0 border-border">
          <TabsContent value="code" className="m-0">
            <CodeTab snapshot={snapshot} owner={owner} repo={repo} repoId={repoId} diff={diff} />
          </TabsContent>
          <TabsContent value="pull-requests" className="m-0">
            <PullRequestsTab repoFullName={snapshot.repo.full_name} />
          </TabsContent>
          <TabsContent value="issues" className="m-0">
            <IssuesTab />
          </TabsContent>
          <TabsContent value="ci" className="m-0">
            <CITab />
          </TabsContent>
          <TabsContent value="daemons" className="m-0">
            <DaemonsTab repoId={repoId} defaultBranch={snapshot.repo.default_branch} />
          </TabsContent>
        </div>
      </Tabs>
    </div>
  );
}

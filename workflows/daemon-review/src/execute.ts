import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import {
  loadMemorySnapshot,
  runDaemon,
  type DaemonSpec,
} from "../../../pkg/daemons/src/index";
import { memorySink } from "../../../pkg/daemons/src/wide-events";
import { reviewLogger } from "./logger";
import { reviewParallelism, type RoutedDaemon } from "./routing";
import type { DaemonOutcome, DaemonReviewConfig, InitialMemoryShape } from "./types";

function proposalModeEnabled(): boolean {
  return process.env.DAEMON_REVIEW_PROPOSAL_MODE === "true";
}

export async function syncTrustedDaemonIntoReviewRoot(
  spec: DaemonSpec,
  trustedRoot: string,
  reviewRoot: string,
): Promise<void> {
  const rel = relative(trustedRoot, spec.file);
  const dest = join(reviewRoot, rel);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, await readFile(spec.file));
}

function renderFilesTouched(diff: string): number {
  const filesTouched = new Set<string>();
  for (const line of diff.split("\n")) {
    const match = line.match(/^\+\+\+ b\/(.+)$/);
    if (match) filesTouched.add(match[1]);
  }
  return filesTouched.size;
}

export function renderOutcome(outcome: DaemonOutcome): string {
  const lines = [`### ${outcome.name}`];
  if (!outcome.ok) {
    lines.push(`- status: failed`);
    lines.push(`- reason: ${outcome.reason ?? "unknown"}`);
    lines.push(`- message: ${outcome.message ?? "daemon failed"}`);
    return lines.join("\n");
  }

  lines.push(`- status: completed`);
  lines.push(`- summary: ${outcome.summary}`);
  if (outcome.findings.length === 0) {
    lines.push(`- findings: none`);
    return lines.join("\n");
  }

  lines.push(`- findings:`);
  for (const finding of outcome.findings) {
    const target = finding.target ? ` (${finding.target})` : "";
    const note = finding.note ? `: ${finding.note}` : "";
    lines.push(`  - ${finding.invariant}${target} -> ${finding.status}${note}`);
  }
  if (outcome.diff.length > 0) {
    lines.push(`- edits: ${renderFilesTouched(outcome.diff)} file(s) touched`);
  }
  return lines.join("\n");
}

async function copyRepoTree(source: string, dest: string): Promise<void> {
  await cp(source, dest, {
    recursive: true,
    filter: (path) => !path.endsWith("/.git") && !path.includes("/.git/"),
  });
}

async function runGit(
  cwd: string,
  args: string[],
): Promise<{ ok: true; stdout: string } | { ok: false; stdout: string; stderr: string }> {
  const proc = Bun.spawn({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode === 0) return { ok: true, stdout };
  return { ok: false, stdout, stderr };
}

async function gitOrThrow(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args);
  if (!result.ok) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

async function buildDaemonReviewInput(
  relevantFiles: string[],
  snapshot: Awaited<ReturnType<typeof loadMemorySnapshot>>,
): Promise<string> {
  const lines = [
    "PR review guidance:",
    "- Start with the changed files listed below.",
    "- Stay inside your daemon's declared scope and routing intent.",
    "- Prefer file reads over shell commands.",
    "- Once one clear mismatch explains an invariant, classify it and move on.",
  ];

  if (proposalModeEnabled()) {
    lines.push(
      "- Proposal mode is active: when you can confidently apply a heal, edit the file directly with `Edit` or `Write` in your working tree. Your edits are scanned post-run and turned into inline `suggestion` review comments (or a stacked fixup PR for changes outside the PR's diff hunks). The real checkout is not modified.",
    );
  }

  lines.push("", "Changed files relevant to this daemon:");
  for (const path of relevantFiles.length > 0 ? relevantFiles : ["(none selected by router)"]) {
    lines.push(`- ${path}`);
  }

  if (snapshot?.staleTrackedSubjects.length) {
    lines.push("", "Tracked subjects invalidated since the nearest verified snapshot:");
    for (const subject of snapshot.staleTrackedSubjects.slice(0, 12)) lines.push(`- ${subject}`);
  }

  return lines.join("\n");
}

function filesTouchedFromDiff(diff: string): string[] {
  const filesTouched = new Set<string>();
  for (const line of diff.split("\n")) {
    const match = line.match(/^\+\+\+ b\/(.+)$/);
    if (match) filesTouched.add(match[1]);
  }
  return [...filesTouched].sort();
}

function summarizeInitialMemory(
  snapshot: Awaited<ReturnType<typeof loadMemorySnapshot>>,
): InitialMemoryShape | null {
  if (!snapshot) return null;
  return {
    snapshotCommit: snapshot.record.commit ?? null,
    currentCommit: snapshot.currentCommit ?? null,
    previousSummary: snapshot.record.lastRun.summary,
    trackedSubjects: Object.keys(snapshot.record.tracked).sort(),
    staleTrackedSubjects: [...snapshot.staleTrackedSubjects].sort(),
    checkedFiles: snapshot.record.lastRun.checkedFiles.map((entry) => entry.path).sort(),
    changedFiles: snapshot.changedFiles.map((entry) => entry.path).sort(),
    newFiles: snapshot.newFiles.map((entry) => entry.path).sort(),
    missingFiles: snapshot.missingFiles.map((entry) => entry.path).sort(),
    changedScopeFiles: snapshot.changedScopeFiles.map((entry) => entry.path).sort(),
  };
}

function viewedFilesFromEvents(outcomeWideEvents: DaemonOutcome["wideEvents"]): string[] {
  const files = new Set<string>();
  for (const event of outcomeWideEvents) {
    if (event.kind !== "daemon.tool.called") continue;
    const checkedPath = event.data.checkedPath;
    if (typeof checkedPath === "string" && checkedPath.length > 0) {
      files.add(checkedPath);
    }
  }
  return [...files].sort();
}

async function runSingleDaemon(
  spec: DaemonSpec,
  trustedRoot: string,
  reviewRoot: string,
  relevantFiles: string[],
): Promise<DaemonOutcome> {
  const proposalMode = proposalModeEnabled();
  const workingRoot = proposalMode
    ? await mkdtemp(join(tmpdir(), `daemon-review-${spec.name}-`))
    : reviewRoot;
  const scopeRoot = resolve(reviewRoot, relative(trustedRoot, spec.scopeRoot));
  const initialSnapshot = await loadMemorySnapshot(spec.name, scopeRoot);
  const reviewInput = await buildDaemonReviewInput(relevantFiles, initialSnapshot);
  const config: DaemonReviewConfig = {
    maxTurns: spec.review.maxTurns,
  };

  if (proposalMode) {
    await copyRepoTree(reviewRoot, workingRoot);
    await gitOrThrow(workingRoot, ["init", "-q", "-b", "base"]);
    await gitOrThrow(workingRoot, ["add", "-A"]);
    await gitOrThrow(workingRoot, [
      "-c",
      "user.email=daemon-review@local",
      "-c",
      "user.name=daemon-review",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "baseline",
    ]);
  }

  reviewLogger.info("running daemon {daemon} against {root}", {
    daemon: spec.name,
    root: workingRoot,
  });
  const wideEventBuffer = memorySink();
  const result = await runDaemon(spec.name, {
    root: workingRoot,
    input: reviewInput,
    maxTurns: config.maxTurns,
    maxWallclockMs: 180_000,
    emit(event) {
      wideEventBuffer.emit(event);
      process.stdout.write(`${JSON.stringify(event)}\n`);
    },
  });

  let diff = "";
  const wideEvents = wideEventBuffer.drain();
  if (proposalMode) {
    try {
      diff = await gitOrThrow(workingRoot, ["diff", "--no-color"]);
    } catch (error) {
      reviewLogger.error("failed to capture daemon diff for {daemon}", {
        daemon: spec.name,
        error,
      });
    }
    await rm(workingRoot, { recursive: true, force: true });
  }

  if (result.ok === false) {
    return {
      name: spec.name,
      ok: false,
      runId: result.runId,
      summary: "",
      findings: [],
      wideEvents,
      turns: result.turns,
      tokens: result.tokens,
      viewedFiles: viewedFilesFromEvents(wideEvents),
      changedFiles: filesTouchedFromDiff(diff),
      initialMemory: summarizeInitialMemory(initialSnapshot),
      diff: "",
      reason: result.reason,
      message: result.message,
    };
  }

  return {
    name: spec.name,
    ok: true,
    runId: result.runId,
    summary: result.payload.summary,
    findings: result.payload.findings,
    wideEvents,
    turns: result.turns,
    tokens: result.tokens,
    viewedFiles: viewedFilesFromEvents(wideEvents),
    changedFiles: filesTouchedFromDiff(diff),
    initialMemory: summarizeInitialMemory(initialSnapshot),
    diff,
  };
}

export async function runDaemonsInParallel(
  routedDaemons: RoutedDaemon[],
  specByName: Map<string, DaemonSpec>,
  trustedRoot: string,
  reviewRoot: string,
): Promise<DaemonOutcome[]> {
  const outcomes = new Array<DaemonOutcome>(routedDaemons.length);
  const parallelism = reviewParallelism(routedDaemons.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      if (index >= routedDaemons.length) return;
      nextIndex += 1;
      const routed = routedDaemons[index];
      const spec = specByName.get(routed.name);
      if (!spec) {
        throw new Error(`missing daemon spec for ${routed.name}`);
      }
      outcomes[index] = await runSingleDaemon(spec, trustedRoot, reviewRoot, routed.relevantFiles);
    }
  }

  await Promise.all(Array.from({ length: parallelism }, () => worker()));
  return outcomes;
}

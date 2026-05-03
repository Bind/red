import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import {
  buildMemoryPrompt,
  collectCheckedFiles,
  createDaemonMemoryStore,
  createEmptyMemoryRecord,
  createFileCodexAuthSource,
  createPiProvider,
  DEFAULT_CODEX_MODEL,
  saveDaemonRun,
  saveMemoryRecord,
  normalizeCheckedPath,
  type AgentProvider,
  type ProviderRunFailure,
  type ProviderRunResult,
  loadMemorySnapshot,
  createTrackTool,
  type DaemonSpec,
} from "../../../pkg/daemons/src/index";
import { createWideEvent, stdoutSink, type WideEvent } from "../../../pkg/daemons/src/wide-events";
import { runAgent } from "../../agent-runtime";
import type { WorkflowObserver } from "../../observability";
import { collectScopeInventory } from "../../../pkg/daemons/src/memory";
import { DEFAULT_OPENROUTER_MODEL, OPENROUTER_PROVIDER_ID } from "../../../pkg/daemons/src/providers/pi";
import { getServerLogger } from "../../../pkg/server/src";
import type {
  DaemonOutcome,
  DaemonReviewConfig,
  InitialMemoryShape,
} from "../../workflows/daemon-review/src/types";

const daemonExecutorLogger = getServerLogger(["bureau", "daemon-executor"]);

type DaemonExecutionInput = {
  spec: DaemonSpec;
  trustedRoot: string;
  reviewRoot: string;
  relevantFiles: string[];
  observer?: WorkflowObserver;
};

type DaemonExecutorDeps = {
  loadMemorySnapshot: typeof loadMemorySnapshot;
  createDaemonMemoryStore: typeof createDaemonMemoryStore;
  createTrackTool: typeof createTrackTool;
  saveMemoryRecord: typeof saveMemoryRecord;
  saveDaemonRun: typeof saveDaemonRun;
  createEmptyMemoryRecord: typeof createEmptyMemoryRecord;
  collectCheckedFiles: typeof collectCheckedFiles;
  collectScopeInventory: typeof collectScopeInventory;
  createPiProvider: typeof createPiProvider;
};

const DEFAULT_MAX_WALLCLOCK_MS = 180_000;
const DAEMON_PREAMBLE = `You are running as a repo daemon.

Operate inside your scope only.
Work in a delta-first way:

- check runner-managed memory first
- prefer changed, new, or invalidated files before broad reads
- reuse prior tracked facts when their dependencies are unchanged
- read the minimum source material needed to confirm or reject a contract
- do not keep exploring after you have enough evidence for real findings

If the runner provides structured review context in the initial input:

- start with the listed changed files
- treat listed authority files as the default source of truth
- avoid exploring outside that set unless a specific mismatch requires it
- prefer file reads over shell commands whenever the files can answer the question
- once one clear mismatch explains an invariant, classify it and move on

Use the \`track\` tool for daemon-local structured memory:

- start by looking up stable subjects relevant to this daemon
- record only compact reusable facts, not long narrative notes
- include precise \`depends_on\` subjects or file paths for recorded facts
- invalidate tracked subjects when you prove they are stale
- record each stable subject at most once per run

If the available memory and unchanged dependencies already answer the audit, complete from memory instead of rereading the repo.

When you can confidently apply a heal, edit the file directly using \`Edit\` or \`Write\`. Your working tree is a sandbox copy of the PR — your edits do not touch the real checkout. The runner diffs your sandbox against the PR head after you finish and turns each hunk into a one-click inline \`suggestion\` review comment when the hunk lands inside the PR's diff, or commits it to a stacked fixup PR otherwise. If the daemon's job is purely auditing, do not edit any files and rely on findings alone.`;

const COMPLETE_TOOL_INSTRUCTIONS = `When — and only when — your task is finished, call the \`complete\` tool exactly once. It takes:

- \`summary\` (required): one-sentence recap of what this run accomplished
- \`findings\` (optional): per-invariant outcomes, each with \`invariant\` (snake_case tag), optional \`target\`, required \`status\` of "ok" | "healed" | "violation_persists" | "skipped", and optional \`note\`
- \`nextRunHint\` (optional): advice for the next invocation

If you have a confident heal for a finding, edit the relevant file directly with \`Edit\` or \`Write\` (see preamble) before calling \`complete\`. Use \`status: "healed"\` on a finding only when you have written the corresponding fix to its file.

Call \`complete\` immediately after you have enough evidence and have recorded any high-value tracked facts for future runs.
Do not spend extra turns on bookkeeping after the audit result is already known.`;

function proposalModeEnabled(): boolean {
  return process.env.DAEMON_REVIEW_PROPOSAL_MODE === "true";
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
    throw new Error(`git command failed: ${result.stderr || result.stdout}`);
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
    const match = line.match(/^\+\+\+ (?:(?:b\/)?(.+)|\/dev\/null)$/);
    if (match?.[1]) filesTouched.add(match[1]);
    const binaryMatch = line.match(/^Binary files (?:a\/)?(.+) and (?:b\/)?(.+) differ$/);
    if (binaryMatch) filesTouched.add(binaryMatch[2]);
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
    if (event.kind !== "agent.tool.called") continue;
    const checkedPath = event.data.checkedPath;
    if (typeof checkedPath === "string" && checkedPath.length > 0) {
      files.add(checkedPath);
    }
  }
  return [...files].sort();
}

export function daemonExecutor(deps: DaemonExecutorDeps = {
  loadMemorySnapshot,
  createDaemonMemoryStore,
  createTrackTool,
  saveMemoryRecord,
  saveDaemonRun,
  createEmptyMemoryRecord,
  collectCheckedFiles,
  collectScopeInventory,
  createPiProvider,
}) {
  return {
    async run(input: DaemonExecutionInput): Promise<DaemonOutcome> {
      const { spec, trustedRoot, reviewRoot, relevantFiles, observer } = input;
      const proposalMode = proposalModeEnabled();
      const workingRoot = proposalMode
        ? await mkdtemp(join(tmpdir(), `daemon-review-${spec.name}-`))
        : reviewRoot;
      const relativeScopeRoot = relative(trustedRoot, spec.scopeRoot);
      const relativeSpecFile = relative(trustedRoot, spec.file);
      const reviewScopeRoot = resolve(reviewRoot, relativeScopeRoot);
      const workingScopeRoot = resolve(workingRoot, relativeScopeRoot);
      const workingSpecFile = resolve(workingRoot, relativeSpecFile);
      const initialSnapshot = await deps.loadMemorySnapshot(spec.name, reviewScopeRoot);
      const reviewInput = await buildDaemonReviewInput(relevantFiles, initialSnapshot);
      const config: DaemonReviewConfig = {
        maxTurns: spec.review.maxTurns,
      };
      const provider = selectProvider(deps);
      const runId = `run_${spec.name}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const startedAt = new Date().toISOString();
      const memoryStore = await deps.createDaemonMemoryStore(spec.name, workingScopeRoot);
      const readPaths = new Set<string>();
      const findingEvents: WideEvent[] = [];
      const systemPrompt = buildSystemPrompt(spec, buildMemoryPrompt(initialSnapshot));
      const fallbackSink = observer ? null : stdoutSink();
      const workflowContext = observer
        ? { workflowRunId: observer.workflowRunId, workflowName: observer.workflowName }
        : {};
      const emitFinding = (data: Record<string, unknown>) => {
        const full = createWideEvent({
          kind: "agent.finding",
          route_name: spec.name,
          data: {
            agentName: spec.name,
            agentRunId: runId,
            ...workflowContext,
            ...data,
          },
        });
        findingEvents.push(full);
        if (observer) {
          observer.emit(full);
        } else if (fallbackSink) {
          fallbackSink(full);
        }
      };

      try {
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

        daemonExecutorLogger.info("running daemon {daemon} against {root}", {
          daemon: spec.name,
          root: workingRoot,
        });

        const { result, events: agentEvents } = await runAgent<ProviderRunResult>(
          {
            agentName: spec.name,
            observer,
            agentRunId: runId,
            startData: {
              provider: provider.name,
              file: relative(process.cwd(), workingSpecFile),
              scopeRoot: relative(process.cwd(), workingScopeRoot),
              input: reviewInput,
            },
            toolCallExtractor: (_turn, toolName, args) => {
              const readPath = extractCheckedPath(workingScopeRoot, toolName, args);
              if (readPath) readPaths.add(readPath);
              return readPath ? { checkedPath: readPath } : null;
            },
            classifyResult: (r) => {
              if (r.ok === false) {
                const failure = r as ProviderRunFailure;
                return {
                  kind: "failed",
                  data: {
                    reason: failure.reason,
                    message: failure.message,
                    inputTokens: failure.tokens.input,
                    outputTokens: failure.tokens.output,
                  },
                };
              }
              return {
                kind: "completed",
                data: {
                  summary: r.payload.summary,
                  findingCount: r.payload.findings.length,
                  nextRunHint: r.payload.nextRunHint ?? null,
                  inputTokens: r.tokens.input,
                  outputTokens: r.tokens.output,
                },
              };
            },
          },
          (hooks) =>
            provider.runUntilComplete({
              cwd: workingScopeRoot,
              systemPrompt,
              maxTurns: config.maxTurns,
              initialInput: reviewInput,
              maxWallclockMs: DEFAULT_MAX_WALLCLOCK_MS,
              extraTools: [deps.createTrackTool(memoryStore, runId)],
              onTurnStart: hooks.onTurnStart,
              onToolCall: hooks.onToolCall,
              onTurnEnd: hooks.onTurnEnd,
            }),
        );

        const diff = await gitOrThrow(workingRoot, ["diff", "--no-color"]);

        if (result.ok === false) {
          const failure = result as ProviderRunFailure;
          const wideEvents = [...agentEvents, ...findingEvents];
          await deps.saveDaemonRun(
            {
              daemon: spec.name,
              scopeRoot: workingScopeRoot,
              file: workingSpecFile,
              runId,
              provider: provider.name,
              systemPrompt,
              input: reviewInput,
              startedAt,
              finishedAt: new Date().toISOString(),
              status: "failed",
              turns: failure.turns,
              tokens: failure.tokens,
              failure: {
                reason: failure.reason,
                message: failure.message,
              },
              events: wideEvents,
            },
            spec.scopeRoot,
          );
          return {
            name: spec.name,
            ok: false,
            runId,
            summary: "",
            findings: [],
            wideEvents,
            turns: failure.turns,
            tokens: failure.tokens,
            viewedFiles: viewedFilesFromEvents(wideEvents),
            changedFiles: filesTouchedFromDiff(diff),
            initialMemory: summarizeInitialMemory(initialSnapshot),
            diff: "",
            reason: failure.reason,
            message: failure.message,
          };
        }

        const freshCheckedFiles = await deps.collectCheckedFiles(workingScopeRoot, readPaths);
        const checkedFiles =
          freshCheckedFiles.length > 0
            ? freshCheckedFiles
            : (initialSnapshot?.record.lastRun.checkedFiles ?? []);
        const fileInventory = await deps.collectScopeInventory(workingScopeRoot);
        const nextRecord = memoryStore.snapshot();
        await deps.saveMemoryRecord(
          {
            ...deps.createEmptyMemoryRecord({
              daemon: spec.name,
              scopeRoot: workingScopeRoot,
              baseCommit: initialSnapshot?.record.commit ?? null,
            }),
            ...nextRecord,
            updatedAt: new Date().toISOString(),
            lastRun: {
              summary: result.payload.summary,
              nextRunHint: result.payload.nextRunHint,
              findings: result.payload.findings,
              checkedFiles,
              fileInventory,
            },
          },
          workingScopeRoot,
        );
        for (const finding of result.payload.findings) {
          emitFinding(finding);
        }
        const wideEvents = [...agentEvents, ...findingEvents];
        await deps.saveDaemonRun(
          {
            daemon: spec.name,
            scopeRoot: workingScopeRoot,
            file: workingSpecFile,
            runId,
            provider: provider.name,
            systemPrompt,
            input: reviewInput,
            startedAt,
            finishedAt: new Date().toISOString(),
            status: "completed",
            turns: result.turns,
            tokens: result.tokens,
            payload: result.payload,
            events: wideEvents,
          },
          workingScopeRoot,
        );

        return {
          name: spec.name,
          ok: true,
          runId,
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
      } finally {
        if (proposalMode) {
          await rm(workingRoot, { recursive: true, force: true });
        }
      }
    },
  };
}

function selectProvider(deps: DaemonExecutorDeps): AgentProvider {
  const name = process.env.AI_DAEMONS_PROVIDER ?? "pi";
  if (name === "pi") {
    return deps.createPiProvider({ authSource: createFileCodexAuthSource() });
  }
  if (name === OPENROUTER_PROVIDER_ID) {
    return deps.createPiProvider({
      provider: OPENROUTER_PROVIDER_ID,
      model: process.env.AI_DAEMONS_MODEL ?? DEFAULT_OPENROUTER_MODEL ?? DEFAULT_CODEX_MODEL,
      apiKey: process.env.OPENROUTER_API_KEY,
    });
  }
  throw new Error(`unsupported AI_DAEMONS_PROVIDER: ${name}`);
}

function buildSystemPrompt(spec: DaemonSpec, memoryPrompt?: string | null): string {
  const sections = [
    `# Daemon: ${spec.name}`,
    "",
    `Description: ${spec.description}`,
    "",
    "You are invoked as a daemon. Your working directory is the scope of your responsibility;",
    "do not touch files outside it. Use the tools available to you.",
    "",
    DAEMON_PREAMBLE,
  ];

  if (memoryPrompt) {
    sections.push("", "---", "", memoryPrompt);
  }

  sections.push("", "---", "", spec.body, "", "---", "", COMPLETE_TOOL_INSTRUCTIONS);
  return sections.join("\n");
}

function extractCheckedPath(scopeRoot: string, toolName: string, args: unknown): string | null {
  if (toolName !== "read" || !args || typeof args !== "object") return null;
  const path = (args as { path?: unknown }).path;
  if (typeof path !== "string" || path.length === 0) return null;
  return normalizeCheckedPath(scopeRoot, path);
}

export default daemonExecutor;

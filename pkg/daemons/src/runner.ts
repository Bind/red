import { relative } from "node:path";
import { resolveDaemon, type DaemonSpec } from "./loader";
import { createFileCodexAuthSource } from "./auth";
import {
  buildMemoryPrompt,
  collectCheckedFiles,
  collectScopeInventory,
  createDaemonMemoryStore,
  createEmptyMemoryRecord,
  loadMemorySnapshot,
  normalizeCheckedPath,
  saveMemoryRecord,
} from "./memory";
import { saveDaemonRun } from "./run-history";
import {
  createPiProvider,
  DEFAULT_OPENROUTER_MODEL,
  OPENROUTER_PROVIDER_ID,
} from "./providers/pi";
import type { AgentProvider, ProviderRunFailure } from "./providers/types";
import type { CompletePayload } from "./schema";
import { createTrackTool } from "./tools/track";
import { createWideEvent, stdoutSink, type WideEvent, type WideEventSink } from "./wide-events";

export type RunOptions = {
  root?: string;
  input?: string;
  maxTurns?: number;
  maxWallclockMs?: number;
  memoryDir?: string;
  provider?: AgentProvider;
  emit?: WideEventSink;
};

export type RunSuccess = {
  ok: true;
  runId: string;
  daemon: string;
  payload: CompletePayload;
  turns: number;
  tokens: { input: number; output: number };
};

export type RunFailure = {
  ok: false;
  runId: string;
  daemon: string;
  reason: "turn_budget_exceeded" | "wallclock_exceeded" | "provider_error";
  message: string;
  turns: number;
  tokens: { input: number; output: number };
};

export type RunResult = RunSuccess | RunFailure;

const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_WALLCLOCK_MS = 5 * 60_000;

export const DAEMON_PREAMBLE = `You are running as a repo daemon.

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

export const COMPLETE_TOOL_INSTRUCTIONS = `When — and only when — your task is finished, call the \`complete\` tool exactly once. It takes:

- \`summary\` (required): one-sentence recap of what this run accomplished
- \`findings\` (optional): per-invariant outcomes, each with \`invariant\` (snake_case tag), optional \`target\`, required \`status\` of "ok" | "healed" | "violation_persists" | "skipped", and optional \`note\`
- \`nextRunHint\` (optional): advice for the next invocation

If you have a confident heal for a finding, edit the relevant file directly with \`Edit\` or \`Write\` (see preamble) before calling \`complete\`. Use \`status: "healed"\` on a finding only when you have written the corresponding fix to its file.

Call \`complete\` immediately after you have enough evidence and have recorded any high-value tracked facts for future runs.
Do not spend extra turns on bookkeeping after the audit result is already known.`;

function newRunId(name: string): string {
  return `run_${name}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
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

function selectProvider(): AgentProvider {
  const name = process.env.AI_DAEMONS_PROVIDER ?? "pi";
  if (name === "pi") {
    return createPiProvider({ authSource: createFileCodexAuthSource() });
  }
  if (name === OPENROUTER_PROVIDER_ID) {
    return createPiProvider({
      provider: OPENROUTER_PROVIDER_ID,
      model: process.env.AI_DAEMONS_MODEL ?? DEFAULT_OPENROUTER_MODEL,
      apiKey: process.env.OPENROUTER_API_KEY,
    });
  }
  throw new Error(`unsupported AI_DAEMONS_PROVIDER: ${name}`);
}

export async function runDaemon(name: string, opts: RunOptions = {}): Promise<RunResult> {
  const spec = await resolveDaemon(name, opts.root);
  return runSpec(spec, opts);
}

export async function runSpec(spec: DaemonSpec, opts: RunOptions = {}): Promise<RunResult> {
  const sink = opts.emit ?? stdoutSink();
  const provider = opts.provider ?? selectProvider();
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxWallclockMs = opts.maxWallclockMs ?? DEFAULT_MAX_WALLCLOCK_MS;
  const runId = newRunId(spec.name);
  const startedAt = new Date().toISOString();
  const previousMemory = await loadMemorySnapshot(spec.name, spec.scopeRoot, opts.memoryDir);
  const memoryStore = await createDaemonMemoryStore(spec.name, spec.scopeRoot, opts.memoryDir);
  const readPaths = new Set<string>();
  const events: WideEvent[] = [];
  const systemPrompt = buildSystemPrompt(spec, buildMemoryPrompt(previousMemory));

  const emit = (event: Omit<WideEvent, "event_id" | "ts">) => {
    const full = createWideEvent(event);
    events.push(full);
    sink(full);
  };

  emit({
    kind: "daemon.run.started",
    route_name: spec.name,
    data: {
      runId,
      provider: provider.name,
      file: relative(process.cwd(), spec.file),
      scopeRoot: relative(process.cwd(), spec.scopeRoot),
      input: opts.input ?? null,
    },
  });

  const result = await provider.runUntilComplete({
    cwd: spec.scopeRoot,
    systemPrompt,
    initialInput: opts.input ?? "Begin your run.",
    maxTurns,
    maxWallclockMs,
    extraTools: [createTrackTool(memoryStore, runId)],
    onTurnStart(turn) {
      emit({
        kind: "daemon.turn.started",
        route_name: spec.name,
        data: { runId, turn },
      });
    },
    onToolCall(turn, toolName, args) {
      const readPath = extractCheckedPath(spec.scopeRoot, toolName, args);
      if (readPath) readPaths.add(readPath);
      emit({
        kind: "daemon.tool.called",
        route_name: spec.name,
        data: { runId, turn, toolName },
      });
    },
    onTurnEnd(turn, info) {
      emit({
        kind: "daemon.turn.completed",
        route_name: spec.name,
        data: {
          runId,
          turn,
          inputTokens: info.tokens.input,
          outputTokens: info.tokens.output,
          completeCalled: info.completeCalled,
        },
      });
    },
  });

  if (result.ok) {
    const freshCheckedFiles = await collectCheckedFiles(spec.scopeRoot, readPaths);
    const checkedFiles =
      freshCheckedFiles.length > 0
        ? freshCheckedFiles
        : (previousMemory?.record.lastRun.checkedFiles ?? []);
    const fileInventory = await collectScopeInventory(spec.scopeRoot);
    const nextRecord = memoryStore.snapshot();
    await saveMemoryRecord(
      {
        ...createEmptyMemoryRecord({
          daemon: spec.name,
          scopeRoot: spec.scopeRoot,
          baseCommit: previousMemory?.record.commit ?? null,
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
      spec.scopeRoot,
      opts.memoryDir,
    );
    for (const finding of result.payload.findings) {
      emit({
        kind: "daemon.finding",
        route_name: spec.name,
        data: { runId, ...finding },
      });
    }
    emit({
      kind: "daemon.run.completed",
      route_name: spec.name,
      data: {
        runId,
        turns: result.turns,
        summary: result.payload.summary,
        findingCount: result.payload.findings.length,
        nextRunHint: result.payload.nextRunHint ?? null,
        inputTokens: result.tokens.input,
        outputTokens: result.tokens.output,
      },
    });
    await saveDaemonRun(
      {
        daemon: spec.name,
        scopeRoot: spec.scopeRoot,
        file: spec.file,
        runId,
        provider: provider.name,
        systemPrompt,
        input: opts.input ?? null,
        startedAt,
        finishedAt: new Date().toISOString(),
        status: "completed",
        turns: result.turns,
        tokens: result.tokens,
        payload: result.payload,
        events,
      },
      spec.scopeRoot,
      opts.memoryDir,
    );
    return {
      ok: true,
      runId,
      daemon: spec.name,
      payload: result.payload,
      turns: result.turns,
      tokens: result.tokens,
    };
  }
  const failure = result as ProviderRunFailure;

  emit({
    kind: "daemon.run.failed",
    route_name: spec.name,
    data: {
      runId,
      reason: failure.reason,
      message: failure.message,
      turns: failure.turns,
      input: failure.tokens.input,
      output: failure.tokens.output,
    },
  });
  await saveDaemonRun(
    {
      daemon: spec.name,
      scopeRoot: spec.scopeRoot,
      file: spec.file,
      runId,
      provider: provider.name,
      systemPrompt,
      input: opts.input ?? null,
      startedAt,
      finishedAt: new Date().toISOString(),
      status: "failed",
      turns: failure.turns,
      tokens: failure.tokens,
      failure: {
        reason: failure.reason,
        message: failure.message,
      },
      events,
    },
    spec.scopeRoot,
    opts.memoryDir,
  );
  return {
    ok: false,
    runId,
    daemon: spec.name,
    reason: failure.reason,
    message: failure.message,
    turns: failure.turns,
    tokens: failure.tokens,
  };
}

function extractCheckedPath(scopeRoot: string, toolName: string, args: unknown): string | null {
  if (toolName !== "read" || !args || typeof args !== "object") return null;
  const path = (args as { path?: unknown }).path;
  if (typeof path !== "string" || path.length === 0) return null;
  return normalizeCheckedPath(scopeRoot, path);
}

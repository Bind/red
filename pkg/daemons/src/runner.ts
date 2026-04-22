import { relative } from "node:path";
import { resolveDaemon, type DaemonSpec } from "./loader";
import { createCodexProvider } from "./providers/codex";
import type { AgentProvider } from "./providers/types";
import type { CompletePayload } from "./schema";
import { COMPLETE_SENTINEL_INSTRUCTIONS, parseCompleteSentinel } from "./sentinel";
import { stdoutSink, type WideEventSink } from "./wide-events";

export type RunOptions = {
  root?: string;
  input?: string;
  maxTurns?: number;
  maxWallclockMs?: number;
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
  reason:
    | "turn_budget_exceeded"
    | "wallclock_exceeded"
    | "malformed_complete"
    | "provider_error";
  message: string;
  turns: number;
  tokens: { input: number; output: number };
};

export type RunResult = RunSuccess | RunFailure;

const DEFAULT_MAX_TURNS = 20;
const DEFAULT_MAX_WALLCLOCK_MS = 5 * 60_000;

function newRunId(name: string): string {
  return `run_${name}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function buildSystemPrompt(spec: DaemonSpec): string {
  return [
    `# Daemon: ${spec.name}`,
    "",
    `Description: ${spec.description}`,
    "",
    "You are invoked as a daemon. Your working directory is the scope of your responsibility;",
    "do not touch files outside it. Use the standard tools available to you.",
    "",
    "---",
    "",
    spec.body,
    "",
    "---",
    "",
    COMPLETE_SENTINEL_INSTRUCTIONS,
  ].join("\n");
}

function selectProvider(): AgentProvider {
  const name = process.env.AI_DAEMONS_PROVIDER ?? "codex";
  if (name === "codex") return createCodexProvider();
  throw new Error(`unsupported AI_DAEMONS_PROVIDER: ${name}`);
}

export async function runDaemon(name: string, opts: RunOptions = {}): Promise<RunResult> {
  const spec = await resolveDaemon(name, opts.root);
  return runSpec(spec, opts);
}

export async function runSpec(spec: DaemonSpec, opts: RunOptions = {}): Promise<RunResult> {
  const emit = opts.emit ?? stdoutSink();
  const provider = opts.provider ?? selectProvider();
  const maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
  const maxWallclockMs = opts.maxWallclockMs ?? DEFAULT_MAX_WALLCLOCK_MS;
  const runId = newRunId(spec.name);
  const startedAt = Date.now();

  let inputTokens = 0;
  let outputTokens = 0;
  let turns = 0;

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

  const session = await provider.spawn({
    cwd: spec.scopeRoot,
    systemPrompt: buildSystemPrompt(spec),
  });

  try {
    let nextInput = opts.input ?? "Begin your run.";

    while (true) {
      if (turns >= maxTurns) {
        return fail(
          "turn_budget_exceeded",
          `exceeded max turns (${maxTurns})`,
          spec,
          runId,
          turns,
          { input: inputTokens, output: outputTokens },
          emit,
        );
      }
      if (Date.now() - startedAt > maxWallclockMs) {
        return fail(
          "wallclock_exceeded",
          `exceeded max wallclock (${maxWallclockMs}ms)`,
          spec,
          runId,
          turns,
          { input: inputTokens, output: outputTokens },
          emit,
        );
      }

      turns += 1;
      emit({
        kind: "daemon.turn.started",
        route_name: spec.name,
        data: { runId, turn: turns },
      });

      let turn;
      try {
        turn = await session.run(nextInput);
      } catch (err) {
        return fail(
          "provider_error",
          err instanceof Error ? err.message : String(err),
          spec,
          runId,
          turns,
          { input: inputTokens, output: outputTokens },
          emit,
        );
      }

      if (turn.usage) {
        inputTokens += turn.usage.inputTokens;
        outputTokens += turn.usage.outputTokens;
      }

      emit({
        kind: "daemon.turn.completed",
        route_name: spec.name,
        data: {
          runId,
          turn: turns,
          inputTokens: turn.usage?.inputTokens ?? 0,
          outputTokens: turn.usage?.outputTokens ?? 0,
          finalResponsePreview: turn.finalResponse.slice(0, 240),
        },
      });

      const sentinel = parseCompleteSentinel(turn.finalResponse);
      if (sentinel.kind === "complete") {
        for (const finding of sentinel.payload.findings) {
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
            turns,
            summary: sentinel.payload.summary,
            findingCount: sentinel.payload.findings.length,
            nextRunHint: sentinel.payload.nextRunHint ?? null,
            inputTokens,
            outputTokens,
          },
        });
        return {
          ok: true,
          runId,
          daemon: spec.name,
          payload: sentinel.payload,
          turns,
          tokens: { input: inputTokens, output: outputTokens },
        };
      }

      if (sentinel.kind === "malformed") {
        nextInput = `Your last message contained a \`complete\` fence but it did not validate: ${sentinel.reason}. Fix the JSON and resend only the fenced block, or continue working if you are not actually done.`;
        continue;
      }

      nextInput =
        "Continue. If you are finished, reply with ONLY the fenced `complete` block as instructed.";
    }
  } finally {
    await session.stop();
  }
}

function fail(
  reason: RunFailure["reason"],
  message: string,
  spec: DaemonSpec,
  runId: string,
  turns: number,
  tokens: { input: number; output: number },
  emit: WideEventSink,
): RunFailure {
  emit({
    kind: "daemon.run.failed",
    route_name: spec.name,
    data: { runId, reason, message, turns, ...tokens },
  });
  return { ok: false, runId, daemon: spec.name, reason, message, turns, tokens };
}

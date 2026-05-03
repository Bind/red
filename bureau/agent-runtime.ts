import { createWideEvent, type WideEvent } from "../pkg/daemons/src/wide-events";
import type { WorkflowObserver } from "./observability";

export type AgentTurnInfo = {
  tokens: { input: number; output: number };
  completeCalled?: boolean;
};

export type AgentEventData = Record<string, unknown>;

export type AgentToolCallExtractor = (
  turn: number,
  toolName: string,
  args: unknown,
) => AgentEventData | null;

export type AgentRunHooks = {
  onTurnStart: (turn: number) => void;
  onToolCall: (turn: number, toolName: string, args: unknown) => void;
  onTurnEnd: (turn: number, info: AgentTurnInfo) => void;
};

export type ProviderRunner<T> = (hooks: AgentRunHooks) => Promise<T>;

export type AgentResultClassification =
  | { kind: "completed"; data?: AgentEventData }
  | { kind: "failed"; data?: AgentEventData };

export type RunAgentOptions<T> = {
  agentName: string;
  observer?: WorkflowObserver;
  agentRunId?: string;
  startData?: AgentEventData;
  toolCallExtractor?: AgentToolCallExtractor;
  classifyResult?: (result: T) => AgentResultClassification;
};

export type RunAgentResult<T> = {
  agentRunId: string;
  result: T;
  events: WideEvent[];
  turns: number;
  tokens: { input: number; output: number };
};

function generateAgentRunId(agentName: string): string {
  return `agent_${agentName}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export async function runAgent<T>(
  options: RunAgentOptions<T>,
  providerCall: ProviderRunner<T>,
): Promise<RunAgentResult<T>> {
  const { agentName, observer, toolCallExtractor, classifyResult, startData } = options;
  const agentRunId = options.agentRunId ?? generateAgentRunId(agentName);
  const events: WideEvent[] = [];
  const startedAt = Date.now();
  let turnsObserved = 0;
  let tokens = { input: 0, output: 0 };

  const emit = (kind: string, data: AgentEventData = {}) => {
    const enriched: AgentEventData = {
      agentName,
      agentRunId,
      ...(observer
        ? { workflowRunId: observer.workflowRunId, workflowName: observer.workflowName }
        : {}),
      ...data,
    };
    const full = createWideEvent({ kind, route_name: agentName, data: enriched });
    events.push(full);
    observer?.emit(full);
  };

  emit("agent.run.started", {
    startedAt: new Date(startedAt).toISOString(),
    ...(startData ?? {}),
  });

  const hooks: AgentRunHooks = {
    onTurnStart(turn) {
      turnsObserved = Math.max(turnsObserved, turn);
      emit("agent.turn.started", { turn });
    },
    onToolCall(turn, toolName, args) {
      const extra = toolCallExtractor?.(turn, toolName, args) ?? null;
      emit("agent.tool.called", { turn, toolName, ...(extra ?? {}) });
    },
    onTurnEnd(turn, info) {
      tokens = {
        input: tokens.input + info.tokens.input,
        output: tokens.output + info.tokens.output,
      };
      emit("agent.turn.completed", {
        turn,
        inputTokens: info.tokens.input,
        outputTokens: info.tokens.output,
        completeCalled: info.completeCalled ?? false,
      });
    },
  };

  let result: T;
  try {
    result = await providerCall(hooks);
  } catch (error) {
    emit("agent.run.failed", {
      durationMs: Date.now() - startedAt,
      turns: turnsObserved,
      tokens,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  const classification = classifyResult?.(result) ?? { kind: "completed" };
  const finalKind =
    classification.kind === "failed" ? "agent.run.failed" : "agent.run.completed";
  emit(finalKind, {
    durationMs: Date.now() - startedAt,
    turns: turnsObserved,
    tokens,
    ...(classification.data ?? {}),
  });

  return { agentRunId, result, events, turns: turnsObserved, tokens };
}

import { Agent, type AgentEvent } from "@mariozechner/pi-agent-core";
import {
  getModel,
  streamSimple,
  type Model,
  type AssistantMessage,
  type Message,
} from "@mariozechner/pi-ai";
import { createCodingTools } from "@mariozechner/pi-coding-agent";
import { CodexAccessTokenManager, type CodexAuthSource } from "../auth";
import { createCompleteTool, COMPLETE_TOOL_NAME, type CompleteCapture } from "../tools/complete";
import type {
  AgentProvider,
  ProviderRunFailure,
  ProviderRunOptions,
  ProviderRunResult,
  ProviderTokenUsage,
} from "./types";

export const CODEX_PROVIDER_ID = "openai-codex";
export const DEFAULT_CODEX_MODEL = "gpt-5.2-codex";

export type PiProviderOptions = {
  authSource: CodexAuthSource;
  /** Provider id recognised by pi-ai's model registry. Default: "openai-codex". */
  provider?: string;
  /** Model id within the provider. Default: "gpt-5.2-codex". */
  model?: string;
  /** Override the resolved Model instance entirely. */
  modelOverride?: Model<"openai-codex-responses">;
};

export function createPiProvider(opts: PiProviderOptions): AgentProvider {
  const tokenManager = new CodexAccessTokenManager(opts.authSource);
  const model =
    opts.modelOverride ??
    (getModel(
      (opts.provider ?? CODEX_PROVIDER_ID) as "openai-codex",
      (opts.model ?? DEFAULT_CODEX_MODEL) as "gpt-5.2-codex",
    ) as Model<"openai-codex-responses">);

  return {
    name: "pi",
    async runUntilComplete(options: ProviderRunOptions): Promise<ProviderRunResult> {
      return runOnce(options, model, tokenManager);
    },
  };
}

async function runOnce(
  options: ProviderRunOptions,
  model: Model<"openai-codex-responses">,
  tokenManager: CodexAccessTokenManager,
): Promise<ProviderRunResult> {
  const capture: CompleteCapture = {};
  const completeTool = createCompleteTool(capture);
  const codingTools = createCodingTools(options.cwd);

  const tokens: ProviderTokenUsage = { input: 0, output: 0 };
  let turnIndex = 0;
  let completeCalledThisTurn = false;
  let toolCallsThisTurn: string[] = [];
  let failureReason: ProviderRunFailure["reason"] | null = null;
  let failureMessage = "";

  const agent = new Agent({
    streamFn: (m, context, streamOptions) =>
      streamSimple(m, context, streamOptions),
    getApiKey: async (provider) => {
      if (provider === CODEX_PROVIDER_ID || provider === "openai-codex-responses") {
        return tokenManager.getAccessToken();
      }
      return undefined;
    },
    convertToLlm: (messages) => messages as Message[],
    toolExecution: "sequential",
  });

  agent.state.model = model;
  agent.state.systemPrompt = options.systemPrompt;
  agent.state.tools = [...codingTools, completeTool];

  const unsubscribe = agent.subscribe((event: AgentEvent) => {
    switch (event.type) {
      case "turn_start":
        turnIndex += 1;
        completeCalledThisTurn = false;
        toolCallsThisTurn = [];
        options.onTurnStart?.(turnIndex);
        break;
      case "tool_execution_start":
        toolCallsThisTurn.push(event.toolName);
        options.onToolCall?.(turnIndex, event.toolName);
        if (event.toolName === COMPLETE_TOOL_NAME) {
          completeCalledThisTurn = true;
        }
        break;
      case "turn_end": {
        const assistantUsage = extractUsage(event.message);
        tokens.input += assistantUsage.input;
        tokens.output += assistantUsage.output;
        options.onTurnEnd?.(turnIndex, {
          tokens: assistantUsage,
          completeCalled: capture.payload !== undefined && completeCalledThisTurn,
        });
        break;
      }
    }
  });

  const abortTimer = setTimeout(() => {
    failureReason = "wallclock_exceeded";
    failureMessage = `exceeded max wallclock (${options.maxWallclockMs}ms)`;
    agent.abort();
  }, options.maxWallclockMs);

  try {
    await agent.prompt(options.initialInput);

    while (true) {
      await agent.waitForIdle();

      if (capture.payload) break;

      if (failureReason) break;

      if (turnIndex >= options.maxTurns) {
        failureReason = "turn_budget_exceeded";
        failureMessage = `exceeded max turns (${options.maxTurns})`;
        break;
      }

      await agent.prompt(
        "Continue. If you are finished, call the `complete` tool exactly once with your summary.",
      );
    }
  } catch (err) {
    if (!failureReason) {
      failureReason = "provider_error";
      failureMessage = err instanceof Error ? err.message : String(err);
    }
  } finally {
    clearTimeout(abortTimer);
    unsubscribe();
  }

  if (capture.payload) {
    return { ok: true, payload: capture.payload, turns: turnIndex, tokens };
  }

  return {
    ok: false,
    reason: failureReason ?? "provider_error",
    message: failureMessage || "agent ended without calling complete",
    turns: turnIndex,
    tokens,
  };
}

function extractUsage(message: unknown): ProviderTokenUsage {
  if (!message || typeof message !== "object") return { input: 0, output: 0 };
  const m = message as AssistantMessage;
  if (m.role !== "assistant") return { input: 0, output: 0 };
  const usage = m.usage;
  if (!usage) return { input: 0, output: 0 };
  return { input: usage.input ?? 0, output: usage.output ?? 0 };
}

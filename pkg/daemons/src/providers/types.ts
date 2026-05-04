import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { CompletePayload } from "../schema";

export type ProviderTokenUsage = { input: number; output: number };

export type ProviderSessionSnapshot = {
  systemPrompt: string;
  messages: unknown[];
};

export type ProviderRunSuccess = {
  ok: true;
  payload: CompletePayload;
  turns: number;
  tokens: ProviderTokenUsage;
  session: ProviderSessionSnapshot;
};

export type ProviderRunFailure = {
  ok: false;
  reason: "turn_budget_exceeded" | "wallclock_exceeded" | "provider_error";
  message: string;
  turns: number;
  tokens: ProviderTokenUsage;
  session: ProviderSessionSnapshot;
};

export type ProviderRunResult = ProviderRunSuccess | ProviderRunFailure;

export type ProviderRunCallbacks = {
  onTurnStart?(turnIndex: number): void;
  onTurnEnd?(turnIndex: number, info: { tokens: ProviderTokenUsage; completeCalled: boolean }): void;
  onToolCall?(turnIndex: number, toolName: string, args?: unknown): void;
  onAssistantTextDelta?(turnIndex: number, delta: string): void;
};

export type ProviderRunOptions = ProviderRunCallbacks & {
  cwd: string;
  systemPrompt: string;
  initialInput: string;
  messages?: unknown[];
  maxTurns: number;
  maxWallclockMs: number;
  extraTools?: AgentTool<any>[];
};

export interface AgentProvider {
  readonly name: string;
  runUntilComplete(opts: ProviderRunOptions): Promise<ProviderRunResult>;
}

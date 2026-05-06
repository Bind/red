import { createOpenAI } from "@ai-sdk/openai";
import { stepCountIs, ToolLoopAgent, type ToolSet } from "ai";
import { CodexAgent, tools as smithersTools } from "smithers-orchestrator";

type TriageAgentMode = "subscription" | "openai-compatible";

function envString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function requiredEnv(name: string): string {
  const value = envString(process.env[name]);
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function loadMode(): TriageAgentMode {
  const value = envString(process.env.TRIAGE_AGENT_MODE)?.toLowerCase();
  if (!value || value === "subscription") return "subscription";
  if (value === "openai-compatible") return "openai-compatible";
  throw new Error(`TRIAGE_AGENT_MODE must be either "subscription" or "openai-compatible"`);
}

function createSubscriptionAgent() {
  return new CodexAgent({
    model: process.env.TRIAGE_SUBSCRIPTION_MODEL ?? "gpt-5.3-codex",
    sandbox: "danger-full-access",
    fullAuto: true,
    config: {
      model_reasoning_effort: process.env.TRIAGE_SUBSCRIPTION_REASONING_EFFORT ?? "high",
    },
    timeoutMs: 30 * 60 * 1000,
  });
}

function createOpenAiCompatibleAgent() {
  const referer = envString(process.env.TRIAGE_OPENAI_REFERER);
  const title = envString(process.env.TRIAGE_OPENAI_TITLE);
  const provider = createOpenAI({
    name: process.env.TRIAGE_OPENAI_PROVIDER_NAME ?? "openai-compatible",
    baseURL: requiredEnv("TRIAGE_OPENAI_BASE_URL"),
    apiKey: requiredEnv("TRIAGE_OPENAI_API_KEY"),
    headers: {
      ...(referer ? { "HTTP-Referer": referer } : {}),
      ...(title ? { "X-Title": title } : {}),
    },
  });

  return new ToolLoopAgent({
    model: provider(process.env.TRIAGE_OPENAI_MODEL ?? "anthropic/claude-sonnet-4.5"),
    tools: smithersTools as ToolSet,
    stopWhen: stepCountIs(100),
    maxOutputTokens: 8192,
  });
}

export function createTriageAgent() {
  switch (loadMode()) {
    case "subscription":
      return createSubscriptionAgent();
    case "openai-compatible":
      return createOpenAiCompatibleAgent();
  }
}

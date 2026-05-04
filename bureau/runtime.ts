import type { AgentProvider, ProviderRunResult } from "../pkg/daemons/src/providers/types";
import {
  createBureauSessionId,
  createLocalBureauSessionStore,
  type BureauStoredSession,
  type PiSessionSnapshot,
} from "./session-store";
import type { BureauAgentContext, BureauAgentDefinition } from "./sdk";

export async function runBureauAgent<Input>(input: {
  definition: BureauAgentDefinition<Input>;
  context: Omit<BureauAgentContext<Input>, "sessionId" | "input">;
  input: Input;
  args: unknown;
  provider: AgentProvider;
  maxTurns: number;
  maxWallclockMs: number;
  mode?: string | null;
  sourceSha?: string | null;
}): Promise<{
  context: BureauAgentContext<Input>;
  plan: Awaited<ReturnType<BureauAgentDefinition<Input>["run"]>>;
  result: ProviderRunResult;
  session: BureauStoredSession;
}> {
  const sessionId = createBureauSessionId();
  const ctx: BureauAgentContext<Input> = {
    ...input.context,
    input: input.input,
    sessionId,
  };
  const plan = await input.definition.run(ctx);
  const result = await input.provider.runUntilComplete({
    cwd: plan.cwd ?? ctx.cwd,
    systemPrompt: plan.systemPrompt,
    initialInput: plan.initialInput,
    maxTurns: input.maxTurns,
    maxWallclockMs: input.maxWallclockMs,
    extraTools: plan.tools ?? [],
  });
  const store = createLocalBureauSessionStore({ rootDir: ctx.root });
  const session = await store.createRoot({
    sessionId,
    agentName: ctx.name,
    args: input.args,
    mode: input.mode ?? null,
    sourceSha: input.sourceSha ?? null,
    snapshot: normalizeSnapshot(result.session),
  });

  return { context: ctx, plan, result, session };
}

function normalizeSnapshot(session: {
  systemPrompt: string;
  messages: unknown[];
}): PiSessionSnapshot {
  return {
    version: 1,
    systemPrompt: session.systemPrompt,
    messages: session.messages,
  };
}

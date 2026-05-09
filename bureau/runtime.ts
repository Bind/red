import type { AgentProvider, ProviderRunCallbacks, ProviderRunResult } from "../pkg/daemons/src/providers/types";
import type { BlobStore } from "./blob-store";
import { harvestBureauOut } from "./harvest";
import {
  createBureauSessionId,
  createLocalBureauSessionStore,
  type BureauStoredSession,
  type PiSessionSnapshot,
} from "./session-store";
import type { BureauAgentContext, BureauAgentDefinition } from "./sdk";

export async function persistRootBureauSession(input: {
  context: Pick<BureauAgentContext<unknown>, "name" | "sessionRoot">;
  sessionId: string;
  args: unknown;
  result: ProviderRunResult;
  mode?: string | null;
  sourceSha?: string | null;
  blobStore?: BlobStore;
  workspaceDir?: string;
}): Promise<BureauStoredSession> {
  const blobs = input.blobStore && input.workspaceDir
    ? await harvestBureauOut({ workspaceDir: input.workspaceDir, sessionId: input.sessionId, store: input.blobStore })
    : undefined;
  const store = createLocalBureauSessionStore({ rootDir: input.context.sessionRoot });
  return await store.createRoot({
    sessionId: input.sessionId,
    agentName: input.context.name,
    args: input.args,
    mode: input.mode ?? null,
    sourceSha: input.sourceSha ?? null,
    snapshot: normalizeSnapshot(input.result.session),
    blobs,
    output: input.result.ok ? input.result.payload : undefined,
  });
}

export async function persistChildBureauSession(input: {
  context: Pick<BureauAgentContext<unknown>, "name" | "sessionRoot">;
  sessionId: string;
  parentSession: BureauStoredSession;
  result: ProviderRunResult;
  mode?: string | null;
  sourceSha?: string | null;
  blobStore?: BlobStore;
  workspaceDir?: string;
}): Promise<BureauStoredSession> {
  const blobs = input.blobStore && input.workspaceDir
    ? await harvestBureauOut({ workspaceDir: input.workspaceDir, sessionId: input.sessionId, store: input.blobStore })
    : undefined;
  const store = createLocalBureauSessionStore({ rootDir: input.context.sessionRoot });
  return await store.createChild({
    sessionId: input.sessionId,
    parentSessionId: input.parentSession.meta.sessionId,
    agentName: input.context.name,
    args: input.parentSession.meta.args,
    mode: input.mode ?? null,
    sourceSha: input.sourceSha ?? null,
    snapshot: normalizeSnapshot(input.result.session),
    blobs,
    output: input.result.ok ? input.result.payload : undefined,
  });
}

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
  providerCallbacks?: ProviderRunCallbacks;
  blobStore?: BlobStore;
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
  const workspaceDir = plan.cwd ?? ctx.cwd;
  const result = await input.provider.runUntilComplete({
    cwd: workspaceDir,
    systemPrompt: plan.systemPrompt,
    initialInput: plan.initialInput,
    maxTurns: input.maxTurns,
    maxWallclockMs: input.maxWallclockMs,
    extraTools: plan.tools ?? [],
    ...input.providerCallbacks,
  });
  const session = await persistRootBureauSession({
    context: ctx,
    sessionId,
    args: input.args,
    result,
    mode: input.mode,
    sourceSha: input.sourceSha,
    blobStore: input.blobStore,
    workspaceDir,
  });

  return { context: ctx, plan, result, session };
}

export async function resumeBureauAgent<Input>(input: {
  definition: BureauAgentDefinition<Input>;
  context: Omit<BureauAgentContext<Input>, "sessionId" | "input">;
  input: Input;
  parentSession: BureauStoredSession;
  provider: AgentProvider;
  maxTurns: number;
  maxWallclockMs: number;
  mode?: string | null;
  sourceSha?: string | null;
  providerCallbacks?: ProviderRunCallbacks;
  blobStore?: BlobStore;
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
  const workspaceDir = plan.cwd ?? ctx.cwd;
  const result = await input.provider.runUntilComplete({
    cwd: workspaceDir,
    systemPrompt: input.parentSession.snapshot.systemPrompt,
    initialInput: plan.initialInput,
    messages: input.parentSession.snapshot.messages,
    maxTurns: input.maxTurns,
    maxWallclockMs: input.maxWallclockMs,
    extraTools: plan.tools ?? [],
    ...input.providerCallbacks,
  });
  const session = await persistChildBureauSession({
    context: ctx,
    sessionId,
    parentSession: input.parentSession,
    result,
    mode: input.mode,
    sourceSha: input.sourceSha,
    blobStore: input.blobStore,
    workspaceDir,
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

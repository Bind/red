import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { type BureauSandboxProvider, bureau } from "../../../bureau/sandbox";
import type { BureauAgentDefinition } from "../../../bureau/sdk";
import type { BureauStoredSession } from "../../../bureau/session-store";
import type { AgentProvider } from "../../../pkg/daemons/src/providers/types";
import type { SessionQueries } from "../db/queries";

export type BureauAdapterDeps = {
  agentSessions: SessionQueries;
  agentProvider: AgentProvider;
  sandboxProvider: BureauSandboxProvider;
  sourceRoot: string;
  maxWallclockMs: number;
};

export type RunBureauForChangeInput<I> = {
  changeId: number;
  jobId: number | null;
  jobType: string;
  agentName: string;
  definition: BureauAgentDefinition<I>;
  input: I;
  args: Record<string, unknown> | null;
  maxTurns?: number;
  deps: BureauAdapterDeps;
};

export type RunBureauForChangeResult<O> = {
  session: BureauStoredSession;
  output: O | undefined;
};

export async function runBureauForChange<I, O>(
  input: RunBureauForChangeInput<I>,
): Promise<RunBureauForChangeResult<O>> {
  const startedAt = Date.now();
  const runId = `bureau-${randomUUID()}`;

  const sessionRow = input.deps.agentSessions.create({
    changeId: input.changeId,
    jobId: input.jobId,
    jobType: input.jobType,
    runId,
    runtime: "bureau",
  });

  try {
    const root = resolve(input.deps.sourceRoot);
    const agentDir = join(root, "bureau", "agents", input.agentName);
    const outcome = await bureau.run({
      provider: input.deps.sandboxProvider,
      agentProvider: input.deps.agentProvider,
      contextBase: {
        name: input.agentName,
        sourceRoot: root,
        sessionRoot: root,
        agentDir,
        assets: { skills: [] },
        emit() {},
        resolveAsset(relativePath: string) {
          return join(agentDir, relativePath);
        },
        resolveSharedAsset(relativePath: string) {
          return join(root, "bureau", "shared", relativePath);
        },
      },
      maxWallclockMs: input.deps.maxWallclockMs,
      definition: input.definition,
      input: input.input,
      args: input.args,
      maxTurns: input.maxTurns ?? 1,
    });

    input.deps.agentSessions.attachRuntimeSessionId(sessionRow.id, outcome.session.meta.sessionId);
    const status = outcome.result.ok ? "completed" : "failed";
    input.deps.agentSessions.finish(sessionRow.id, status, Date.now() - startedAt);

    return {
      session: outcome.session,
      output: outcome.session.meta.output as O | undefined,
    };
  } catch (error) {
    input.deps.agentSessions.finish(sessionRow.id, "failed", Date.now() - startedAt);
    throw error;
  }
}

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentProvider } from "../../../pkg/daemons/src/providers/types";
import type { BlobStore } from "../../blob-store";
import {
  triageAnalyze,
  type TriagePlan,
  type WideRollupRecord,
} from "../../agents/triage-analyze/agent";
import {
  triagePropose,
  type TriageProposal,
} from "../../agents/triage-propose/agent";
import { resumeBureauAgent } from "../../runtime";
import { bureau, type BureauSandboxProvider } from "../../sandbox";
import {
  createLocalBureauSessionStore,
  type BureauStoredSession,
} from "../../session-store";

export type TriageDecision = {
  state: "approved" | "rejected";
  decidedAt: string;
};

export type TriageWorkflowDeps = {
  agentProvider: AgentProvider;
  sandboxProvider: BureauSandboxProvider;
  /** Path used for asset resolution and the bureau session store root. */
  sourceRoot: string;
  maxWallclockMs: number;
  blobStore?: BlobStore;
};

export type RunTriageAnalyzeResult = {
  session: BureauStoredSession;
  plan: TriagePlan;
};

export async function runTriageAnalyze(input: {
  rollup: WideRollupRecord;
  deps: TriageWorkflowDeps;
}): Promise<RunTriageAnalyzeResult> {
  const root = resolve(input.deps.sourceRoot);
  const agentDir = join(root, "bureau", "agents", "triage-analyze");

  const outcome = await bureau.run({
    provider: input.deps.sandboxProvider,
    agentProvider: input.deps.agentProvider,
    contextBase: {
      name: "triage-analyze",
      sourceRoot: root,
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
    blobStore: input.deps.blobStore,
    definition: triageAnalyze(),
    input: input.rollup,
    args: { rollupId: input.rollup.request_id },
    maxTurns: 1,
  });

  return {
    session: outcome.session,
    plan: outcome.session.meta.output as TriagePlan,
  };
}

function decisionPath(sourceRoot: string, sessionId: string): string {
  return join(resolve(sourceRoot), ".bureau", "sessions", sessionId, "decision.json");
}

export async function markTriageDecision(input: {
  sessionId: string;
  decision: "approved" | "rejected";
  sourceRoot: string;
}): Promise<TriageDecision> {
  const decision: TriageDecision = {
    state: input.decision,
    decidedAt: new Date().toISOString(),
  };
  await writeFile(
    decisionPath(input.sourceRoot, input.sessionId),
    `${JSON.stringify(decision, null, 2)}\n`,
  );
  return decision;
}

export async function readTriageDecision(input: {
  sessionId: string;
  sourceRoot: string;
}): Promise<TriageDecision | null> {
  try {
    const raw = await readFile(decisionPath(input.sourceRoot, input.sessionId), "utf8");
    return JSON.parse(raw) as TriageDecision;
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export type RunTriageProposeResult = {
  session: BureauStoredSession;
  proposal: TriageProposal;
};

export async function runTriagePropose(input: {
  analyzeSessionId: string;
  deps: TriageWorkflowDeps;
}): Promise<RunTriageProposeResult> {
  const root = resolve(input.deps.sourceRoot);

  const decision = await readTriageDecision({
    sessionId: input.analyzeSessionId,
    sourceRoot: root,
  });
  if (decision?.state !== "approved") {
    throw new Error(
      `triage analyze session ${input.analyzeSessionId} has not been approved (current decision: ${decision?.state ?? "none"})`,
    );
  }

  const store = createLocalBureauSessionStore({ rootDir: root });
  const parentSession = await store.get(input.analyzeSessionId);
  if (!parentSession) {
    throw new Error(`triage analyze session ${input.analyzeSessionId} not found`);
  }
  const plan = parentSession.meta.output as TriagePlan | undefined;
  if (!plan) {
    throw new Error(
      `triage analyze session ${input.analyzeSessionId} has no plan output to propose against`,
    );
  }

  const agentDir = join(root, "bureau", "agents", "triage-propose");
  const sandboxSession = await input.deps.sandboxProvider.create({ preserve: false });
  try {
    const outcome = await resumeBureauAgent({
      definition: triagePropose(),
      input: { plan },
      parentSession,
      provider: input.deps.agentProvider,
      maxTurns: 1,
      maxWallclockMs: input.deps.maxWallclockMs,
      blobStore: input.deps.blobStore,
      context: {
        name: "triage-propose",
        sourceRoot: root,
        root: sandboxSession.root,
        cwd: sandboxSession.root,
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
    });

    return {
      session: outcome.session,
      proposal: outcome.session.meta.output as TriageProposal,
    };
  } finally {
    await sandboxSession.cleanup();
  }
}

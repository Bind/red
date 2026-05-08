import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AgentProvider } from "../../../pkg/daemons/src/providers/types";
import type { BlobStore } from "../../blob-store";
import {
  createTriageAnalyzeAgentInstance,
  type TriagePlan,
  type WideRollupRecord,
} from "../../agents/triage-analyze/agent";
import {
  createTriageProposeAgentInstance,
  type TriageProposal,
} from "../../agents/triage-propose/agent";
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
  const agent = createTriageAnalyzeAgentInstance(input.rollup, root);

  const outcome = await bureau.run({
    provider: input.deps.sandboxProvider,
    agentProvider: input.deps.agentProvider,
    agent,
    maxWallclockMs: input.deps.maxWallclockMs,
    blobStore: input.deps.blobStore,
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

  const agent = createTriageProposeAgentInstance({ plan }, root);
  const outcome = await bureau.resume({
    provider: input.deps.sandboxProvider,
    agentProvider: input.deps.agentProvider,
    agent,
    parentSession,
    maxTurns: 1,
    maxWallclockMs: input.deps.maxWallclockMs,
    blobStore: input.deps.blobStore,
  });

  return {
    session: outcome.session,
    proposal: outcome.session.meta.output as TriageProposal,
  };
}

export type TriageRunSummary = {
  id: string;
  status:
    | "plan_ready"
    | "approved"
    | "rejected"
    | "proposal_ready"
    | "failed";
  created_at: string;
  updated_at: string;
  rollup: WideRollupRecord;
  plan?: { hypothesis: string; confidence: TriagePlan["confidence"] };
  proposal?: { repo_id: string; branch: string; pr_url: string | undefined };
};

export async function listTriageRuns(input: {
  sourceRoot: string;
}): Promise<TriageRunSummary[]> {
  const root = resolve(input.sourceRoot);
  const store = createLocalBureauSessionStore({ rootDir: root });
  const [analyzeMetas, proposeMetas] = await Promise.all([
    store.list({ agentName: "triage-analyze" }),
    store.list({ agentName: "triage-propose" }),
  ]);
  const proposeByParent = new Map<string, (typeof proposeMetas)[number]>();
  for (const meta of proposeMetas) {
    if (meta.parentSessionId) proposeByParent.set(meta.parentSessionId, meta);
  }

  const summaries: TriageRunSummary[] = [];
  for (const meta of analyzeMetas) {
    const rollup = (meta.args as { rollup?: WideRollupRecord } | null)?.rollup;
    if (!rollup) continue;
    const plan = meta.output as TriagePlan | undefined;
    const decision = await readTriageDecision({ sessionId: meta.sessionId, sourceRoot: root });
    const proposeMeta = proposeByParent.get(meta.sessionId);
    const proposal = proposeMeta?.output as TriageProposal | undefined;

    let status: TriageRunSummary["status"];
    if (proposal) {
      status = "proposal_ready";
    } else if (decision?.state === "approved") {
      status = "approved";
    } else if (decision?.state === "rejected") {
      status = "rejected";
    } else if (plan) {
      status = "plan_ready";
    } else {
      status = "failed";
    }

    summaries.push({
      id: meta.sessionId,
      status,
      created_at: meta.createdAt,
      updated_at: proposeMeta?.updatedAt ?? meta.updatedAt,
      rollup,
      plan: plan
        ? { hypothesis: plan.hypothesis, confidence: plan.confidence }
        : undefined,
      proposal: proposal
        ? { repo_id: proposal.repoId, branch: proposal.branch, pr_url: proposal.prUrl }
        : undefined,
    });
  }

  summaries.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  return summaries;
}

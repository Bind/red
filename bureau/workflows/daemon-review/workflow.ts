import { daemonExecutor } from "../../daemon-executor/agent";
import { librarian } from "../../librarian/agent";
import type { SandboxRepo } from "../../repo";
import { sandbox } from "../../sandbox";
import { createWideEvent, memorySink, stdoutSink, type WideEvent } from "../../../pkg/daemons/src/wide-events";
import {
  loadDaemonReviewInputs,
  routeChangedFilesToDaemons,
  runSelectedDaemons,
} from "./src/core";
import { reviewLogger } from "./src/logger";
import type {
  ProposalArtifacts,
  ReviewExecutionResult,
  ReviewRoutingResult,
} from "./src/types";

export type DaemonReviewWorkflowInput = {
  trunkRepo: SandboxRepo;
  branchRepo: SandboxRepo;
  baseRef: string;
  headRef: string;
  changedFiles: string[];
  preserveSandbox?: boolean;
  daemonName?: string;
  daemonLimit?: number;
  librarianModel?: string;
};

export type DaemonReviewWorkflowResult = {
  workflowRunId: string;
  trunkRepoId: string;
  branchRepoId: string;
  baseRef: string;
  headRef: string;
  trunkCodebaseRoot: string;
  branchCodebaseRoot: string;
  sandboxRoot: string | null;
  changedFiles: string[];
  routing: ReviewRoutingResult;
  summary: string;
  proposalArtifacts: ProposalArtifacts | null;
  execution: ReviewExecutionResult;
  wideEvents: WideEvent[];
};

/**
 * Example plain-code workflow.
 *
 * This is intentionally just orchestration code:
 * - prepare a sandbox
 * - seed the review workspace
 * - invoke the existing daemon-review execution engine
 * - return artifacts/results to the caller
 *
 * It does not introduce a workflow builder DSL.
 */
export async function runDaemonReviewWorkflow(
  input: DaemonReviewWorkflowInput,
): Promise<DaemonReviewWorkflowResult> {
  const workflowRunId = `workflow_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const sink = stdoutSink();
  const buffer = memorySink();
  const emit = (kind: string, data: Record<string, unknown>) => {
    const event = createWideEvent({
      kind,
      route_name: "daemon-review",
      data: { workflowRunId, ...data },
    });
    sink(event);
    buffer.emit(event);
  };

  reviewLogger.info("starting daemon-review workflow", {
    workflowRunId,
    trunkRepo: input.trunkRepo.id,
    branchRepo: input.branchRepo.id,
    baseRef: input.baseRef,
    headRef: input.headRef,
    changedFiles: input.changedFiles.length,
    daemonName: input.daemonName ?? null,
  });
  emit("daemon.workflow.started", {
    trunkRepo: input.trunkRepo.id,
    branchRepo: input.branchRepo.id,
    baseRef: input.baseRef,
    headRef: input.headRef,
    changedFiles: input.changedFiles,
    daemonName: input.daemonName ?? null,
  });

  const sb = await sandbox.justBash().create({
    preserve: input.preserveSandbox === true,
  });

  try {
    emit("daemon.workflow.sandbox.created", {
      sandboxRoot: sb.exposedRoot,
      provider: sb.name,
    });
    const trunkCodebase = await sb.clone({
      repo: input.trunkRepo,
      ref: input.baseRef,
      dest: "trusted",
    });
    emit("daemon.workflow.codebase.cloned", {
      role: "trunk",
      repo: input.trunkRepo.id,
      ref: input.baseRef,
      root: trunkCodebase.root,
      dest: trunkCodebase.dest,
    });

    const branchCodebase = await sb.clone({
      repo: input.branchRepo,
      ref: input.headRef,
      dest: "review",
    });
    emit("daemon.workflow.codebase.cloned", {
      role: "branch",
      repo: input.branchRepo.id,
      ref: input.headRef,
      root: branchCodebase.root,
      dest: branchCodebase.dest,
    });

    const routingLibrarian = librarian({
      model: input.librarianModel,
      cwd: branchCodebase.root,
    });

    const daemonReviewer = daemonExecutor();

    const reviewInputs = await loadDaemonReviewInputs({
      trustedRoot: trunkCodebase.root,
      reviewRoot: branchCodebase.root,
    });
    emit("daemon.workflow.inputs.loaded", {
      specs: reviewInputs.specs.map((spec) => spec.name),
      trustedRoot: reviewInputs.trustedRoot,
      reviewRoot: reviewInputs.reviewRoot,
    });

    const routing = await routeChangedFilesToDaemons(reviewInputs, {
      changedFiles: input.changedFiles,
      daemonName: input.daemonName,
      daemonLimit: input.daemonLimit,
      librarianOverride: routingLibrarian,
      routerProvider: "openrouter",
      routerModel: process.env.DAEMON_REVIEW_ROUTER_MODEL ?? "openai/text-embedding-3-small",
    });
    emit("daemon.workflow.routing.completed", {
      routedDaemons: routing.routedDaemons,
      fileDebug: routing.evaluation.fileDebug.map((entry) => ({
        file: entry.file,
        selectedDaemons: entry.selectedDaemons,
        librarianRationale: entry.librarianRationale ?? null,
        librarianConfidence: entry.librarianConfidence ?? null,
      })),
    });

    const execution = await runSelectedDaemons(reviewInputs, {
      changedFiles: input.changedFiles,
      routedDaemons: routing.routedDaemons,
      daemonReviewer,
    });
    emit("daemon.workflow.execution.completed", {
      routedDaemons: execution.routedDaemons,
      outcomes: execution.outcomes.map((outcome) => ({
        name: outcome.name,
        ok: outcome.ok,
        changedFiles: outcome.changedFiles,
        findings: outcome.findings,
      })),
      blockingFailures: execution.blockingFailures.map((outcome) => outcome.name),
      editCount: execution.proposalArtifacts?.edits.length ?? 0,
    });

    const wideEvents = [
      ...buffer.drain(),
      ...execution.outcomes.flatMap((outcome) => outcome.wideEvents),
    ];
    reviewLogger.info("daemon-review workflow completed", {
      workflowRunId,
      routedDaemons: execution.routedDaemons.map((entry) => entry.name),
      blockingFailures: execution.blockingFailures.map((entry) => entry.name),
      editCount: execution.proposalArtifacts?.edits.length ?? 0,
    });

    return {
      workflowRunId,
      trunkRepoId: input.trunkRepo.id,
      branchRepoId: input.branchRepo.id,
      baseRef: input.baseRef,
      headRef: input.headRef,
      trunkCodebaseRoot: trunkCodebase.root,
      branchCodebaseRoot: branchCodebase.root,
      sandboxRoot: sb.exposedRoot,
      changedFiles: input.changedFiles,
      routing,
      summary: execution.summary,
      proposalArtifacts: execution.proposalArtifacts,
      execution,
      wideEvents,
    };
  } catch (error) {
    reviewLogger.error("daemon-review workflow failed", {
      workflowRunId,
      error,
    });
    emit("daemon.workflow.failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    await sb.cleanup();
  }
}

export function describeDaemonReviewWorkflow(
  result: DaemonReviewWorkflowResult,
): string {
  const daemonNames = result.execution.routedDaemons.map((entry) => entry.name);

  return [
    "# Daemon Review Workflow",
    "",
    `Sandbox mode: just-bash`,
    `Trunk repo: ${result.trunkRepoId}`,
    `Branch repo: ${result.branchRepoId}`,
    `Compare: ${result.baseRef}..${result.headRef}`,
    `Trunk codebase: ${result.trunkCodebaseRoot}`,
    `Branch codebase: ${result.branchCodebaseRoot}`,
    `Changed files: ${result.changedFiles.length}`,
    `Daemons: ${daemonNames.join(", ") || "(none)"}`,
    "",
    result.summary,
  ].join("\n");
}

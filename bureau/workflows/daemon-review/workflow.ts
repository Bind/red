import { daemonExecutor } from "../../agents/daemon-executor/agent";
import { librarian } from "../../agents/librarian/agent";
import { startWorkflowObserver } from "../../observability";
import type { SandboxRepo } from "../../repo";
import { sandbox } from "../../sandbox";
import type { WideEvent } from "../../../pkg/daemons/src/wide-events";
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

export async function runDaemonReviewWorkflow(
  input: DaemonReviewWorkflowInput,
): Promise<DaemonReviewWorkflowResult> {
  const observer = startWorkflowObserver({ workflowName: "daemon-review" });
  const startedAt = Date.now();

  observer.event("workflow.run.started", {
    startedAt: new Date(startedAt).toISOString(),
    trunkRepo: input.trunkRepo.id,
    branchRepo: input.branchRepo.id,
    baseRef: input.baseRef,
    headRef: input.headRef,
    changedFiles: input.changedFiles,
    daemonName: input.daemonName ?? null,
  });
  reviewLogger.info("starting daemon-review workflow", {
    workflowRunId: observer.runId,
    trunkRepo: input.trunkRepo.id,
    branchRepo: input.branchRepo.id,
    baseRef: input.baseRef,
    headRef: input.headRef,
    changedFiles: input.changedFiles.length,
    daemonName: input.daemonName ?? null,
  });

  const sb = await sandbox.justBash().create({
    preserve: input.preserveSandbox === true,
    observer,
  });

  try {
    const trunkCodebase = await observer.step("clone.trunk", () =>
      sb.clone({
        repo: input.trunkRepo,
        ref: input.baseRef,
        dest: "trusted",
        role: "trunk",
      }),
    );

    const branchCodebase = await observer.step("clone.branch", () =>
      sb.clone({
        repo: input.branchRepo,
        ref: input.headRef,
        dest: "review",
        role: "branch",
      }),
    );

    const routingLibrarian = librarian({
      model: input.librarianModel,
      cwd: branchCodebase.root,
    });

    const daemonReviewer = daemonExecutor();

    const reviewInputs = await observer.step("inputs.load", async (step) => {
      const loaded = await loadDaemonReviewInputs({
        trustedRoot: trunkCodebase.root,
        reviewRoot: branchCodebase.root,
      });
      step.event("inputs.loaded", {
        specs: loaded.specs.map((spec) => spec.name),
        trustedRoot: loaded.trustedRoot,
        reviewRoot: loaded.reviewRoot,
      });
      return loaded;
    });

    const routing = await observer.step("route", async (step) => {
      const routed = await routeChangedFilesToDaemons(reviewInputs, {
        changedFiles: input.changedFiles,
        daemonName: input.daemonName,
        daemonLimit: input.daemonLimit,
        librarianOverride: routingLibrarian,
        routerProvider: "openrouter",
        routerModel: process.env.DAEMON_REVIEW_ROUTER_MODEL ?? "openai/text-embedding-3-small",
      });
      step.event("routing.summary", {
        routedDaemons: routed.routedDaemons,
        fileDebug: routed.evaluation.fileDebug.map((entry) => ({
          file: entry.file,
          selectedDaemons: entry.selectedDaemons,
          librarianRationale: entry.librarianRationale ?? null,
          librarianConfidence: entry.librarianConfidence ?? null,
        })),
      });
      return routed;
    });

    const execution = await observer.step("execute", async (step) => {
      const result = await runSelectedDaemons(reviewInputs, {
        changedFiles: input.changedFiles,
        routedDaemons: routing.routedDaemons,
        daemonReviewer,
        observer,
      });
      step.event("execution.summary", {
        routedDaemons: result.routedDaemons,
        outcomes: result.outcomes.map((outcome) => ({
          name: outcome.name,
          ok: outcome.ok,
          changedFiles: outcome.changedFiles,
          findings: outcome.findings,
        })),
        blockingFailures: result.blockingFailures.map((outcome) => outcome.name),
        editCount: result.proposalArtifacts?.edits.length ?? 0,
      });
      return result;
    });

    observer.event("workflow.run.completed", {
      durationMs: Date.now() - startedAt,
      status: "completed",
    });
    reviewLogger.info("daemon-review workflow completed", {
      workflowRunId: observer.runId,
      routedDaemons: execution.routedDaemons.map((entry) => entry.name),
      blockingFailures: execution.blockingFailures.map((entry) => entry.name),
      editCount: execution.proposalArtifacts?.edits.length ?? 0,
    });

    const wideEvents = observer.drain();

    return {
      workflowRunId: observer.runId,
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
    observer.event("workflow.run.failed", {
      durationMs: Date.now() - startedAt,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    reviewLogger.error("daemon-review workflow failed", {
      workflowRunId: observer.runId,
      error,
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

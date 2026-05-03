import { relative, resolve } from "node:path";
import { loadDaemons, loadMemorySnapshot, type DaemonSpec } from "../../../../pkg/daemons/src/index";
import type { WorkflowObserver } from "../../../observability";
import { daemonExecutor } from "../../../agents/daemon-executor/agent";
import { buildDaemonRoutingMemory } from "./routing-memory";
import {
  evaluateRouting,
  reviewParallelism,
  type RoutedDaemon,
} from "./routing";
import {
  copyTrustedDaemonSpecIntoReviewCodebase,
  renderOutcome,
  runRoutedDaemons,
  type DaemonExecutorInstance,
} from "./execute";
import { blockingOutcomes } from "./proposals";
import type {
  ReviewExecutionContext,
  ReviewExecutionResult,
  ReviewPreparedContext,
  ReviewRoutingContext,
  ReviewRoutingResult,
} from "./types";

function filesTouchedFromDiff(diff: string): string[] {
  const filesTouched = new Set<string>();
  for (const line of diff.split("\n")) {
    const match = line.match(/^\+\+\+ b\/(.+)$/);
    if (match) filesTouched.add(match[1]);
  }
  return [...filesTouched].sort();
}

function buildSummary(
  changedFiles: string[],
  routedDaemons: string[],
  outcomes: ReviewExecutionResult["outcomes"],
): string {
  const summaryLines = [
    `Changed files: ${changedFiles.length}`,
    `Daemons: ${routedDaemons.join(", ")}`,
    `Parallelism: ${reviewParallelism(routedDaemons.length)}`,
    "",
    ...outcomes.map(renderOutcome),
    "",
  ];
  return summaryLines.join("\n");
}

export async function runReviewExecution(
  context: ReviewExecutionContext,
): Promise<ReviewExecutionResult> {
  if (!context.librarianOverride) {
    throw new Error("runReviewExecution requires a workflow-provided librarianOverride");
  }
  const prepared = await loadDaemonReviewInputs(context);
  const routing = await routeChangedFilesToDaemons(prepared, {
    changedFiles: context.changedFiles,
    daemonName: context.daemonName,
    daemonLimit: context.daemonLimit,
    librarianOverride: context.librarianOverride,
    routerProvider: "openrouter",
    routerModel: process.env.DAEMON_REVIEW_ROUTER_MODEL ?? "openai/text-embedding-3-small",
  });
  return runSelectedDaemons(prepared, {
    changedFiles: context.changedFiles,
    routedDaemons: routing.routedDaemons,
    daemonReviewer: daemonExecutor(),
  });
}

export async function loadDaemonReviewInputs(
  context: Pick<ReviewExecutionContext, "trustedRoot" | "reviewRoot">,
): Promise<ReviewPreparedContext> {
  const { specs, errors } = await loadDaemons(context.trustedRoot);
  if (errors.length > 0) {
    throw new Error(
      `failed to load daemons:\n${errors.map((error) => `- ${error.file}: ${error.message}`).join("\n")}`,
    );
  }

  const specByName = new Map(specs.map((spec) => [spec.name, spec] satisfies [string, DaemonSpec]));
  const memoryByDaemon = new Map();
  for (const spec of specs) {
    const scopeRoot = resolve(context.reviewRoot, relative(context.trustedRoot, spec.scopeRoot));
    const scopePrefix = relative(context.reviewRoot, scopeRoot).replace(/\\/g, "/");
    const snapshot = await loadMemorySnapshot(spec.name, scopeRoot);
    memoryByDaemon.set(spec.name, buildDaemonRoutingMemory(snapshot, scopePrefix));
  }

  return {
    trustedRoot: context.trustedRoot,
    reviewRoot: context.reviewRoot,
    specs,
    specByName,
    memoryByDaemon,
  };
}

export async function routeChangedFilesToDaemons(
  prepared: ReviewPreparedContext,
  context: ReviewRoutingContext,
): Promise<ReviewRoutingResult> {
  if (context.daemonName) {
    const explicitSpec = prepared.specByName.get(context.daemonName);
    if (!explicitSpec) {
      throw new Error(`unknown daemon: ${context.daemonName}`);
    }
    const scopePrefix = relative(prepared.trustedRoot, explicitSpec.scopeRoot).replace(/\\/g, "/");
    const inScope = context.changedFiles.filter((file) =>
      scopePrefix === ""
        ? true
        : file === scopePrefix || file.startsWith(`${scopePrefix}/`)
    );
    return {
      evaluation: {
        fileDebug: context.changedFiles.map((file) => ({
          file,
          selectedDaemons: [explicitSpec.name],
          fileSummary: "",
          scores: [],
          mode: "memory_embedding_librarian",
          librarianRationale: "explicit daemon override",
        })),
        routedDaemons: [{
          name: explicitSpec.name,
          relevantFiles: inScope.length > 0 ? inScope : context.changedFiles,
        }],
      },
      routedDaemons: [{
        name: explicitSpec.name,
        relevantFiles: inScope.length > 0 ? inScope : context.changedFiles,
      }],
    };
  }

  const evaluation = await evaluateRouting(context.changedFiles, prepared.specs, {
    modeOverride: "memory_embedding_librarian",
    memoryByDaemon: prepared.memoryByDaemon,
    librarianOverride: context.librarianOverride,
    routerProviderOverride: context.routerProvider,
    routerModelOverride: context.routerModel,
  });
  let filteredRoutedDaemons: RoutedDaemon[];
  filteredRoutedDaemons = evaluation.routedDaemons.slice(
    0,
    context.daemonLimit ?? evaluation.routedDaemons.length,
  );

  return {
    evaluation,
    routedDaemons: filteredRoutedDaemons,
  };
}

export async function runSelectedDaemons(
  prepared: ReviewPreparedContext,
  context: {
    changedFiles: string[];
    routedDaemons: RoutedDaemon[];
    daemonReviewer: DaemonExecutorInstance;
    observer?: WorkflowObserver;
  },
): Promise<ReviewExecutionResult> {
  const { changedFiles, routedDaemons, daemonReviewer, observer } = context;
  const daemonNames = routedDaemons.map((entry) => entry.name);

  if (daemonNames.length === 0) {
    return {
      changedFiles,
      specs: prepared.specs,
      routedDaemons,
      outcomes: [],
      summary: ["Changed files: 0", "Daemons: none", "", "No matching daemons for this diff."].join("\n"),
      blockingFailures: [],
      proposalArtifacts: null,
    };
  }

  for (const routed of routedDaemons) {
    const spec = prepared.specByName.get(routed.name);
    if (!spec) {
      throw new Error(`missing daemon spec for ${routed.name}`);
    }
    await copyTrustedDaemonSpecIntoReviewCodebase(spec, prepared.trustedRoot, prepared.reviewRoot);
  }

  const outcomes = await runRoutedDaemons(
    routedDaemons,
    prepared.specByName,
    prepared.trustedRoot,
    prepared.reviewRoot,
    daemonReviewer,
    observer,
  );
  const edits = outcomes
    .filter((outcome) => outcome.ok && outcome.diff.trim().length > 0)
    .map((outcome) => ({
      daemonName: outcome.name,
      diff: outcome.diff,
      filesTouched: filesTouchedFromDiff(outcome.diff),
    }));

  return {
    changedFiles,
    specs: prepared.specs,
    routedDaemons,
    outcomes,
    summary: buildSummary(changedFiles, daemonNames, outcomes),
    blockingFailures: blockingOutcomes(outcomes),
    proposalArtifacts: edits.length > 0 ? { edits } : null,
  };
}

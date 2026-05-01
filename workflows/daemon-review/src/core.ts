import { relative, resolve } from "node:path";
import { loadDaemons, loadMemorySnapshot, type DaemonSpec } from "../../../pkg/daemons/src/index";
import { buildDaemonRoutingMemory } from "./routing-memory";
import { reviewParallelism, routeDaemons, type RoutedDaemon } from "./routing";
import { renderOutcome, runDaemonsInParallel, syncTrustedDaemonIntoReviewRoot } from "./execute";
import { blockingOutcomes } from "./proposals";
import type { ReviewExecutionContext, ReviewExecutionResult } from "./types";

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

  const routedDaemons = await routeDaemons(context.changedFiles, specs, { memoryByDaemon });
  let filteredRoutedDaemons: RoutedDaemon[];
  if (context.daemonName) {
    const explicit = routedDaemons.find((entry) => entry.name === context.daemonName);
    if (explicit) {
      filteredRoutedDaemons = [explicit];
    } else {
      const explicitSpec = specByName.get(context.daemonName);
      if (!explicitSpec) {
        throw new Error(`unknown daemon: ${context.daemonName}`);
      }
      const scopePrefix = relative(context.trustedRoot, explicitSpec.scopeRoot).replace(/\\/g, "/");
      const inScope = context.changedFiles.filter((file) =>
        scopePrefix === ""
          ? true
          : file === scopePrefix || file.startsWith(`${scopePrefix}/`)
      );
      filteredRoutedDaemons = [{
        name: explicitSpec.name,
        relevantFiles: inScope.length > 0 ? inScope : context.changedFiles,
      }];
    }
  } else {
    filteredRoutedDaemons = routedDaemons.slice(0, context.daemonLimit ?? routedDaemons.length);
  }
  const daemonNames = filteredRoutedDaemons.map((entry) => entry.name);

  if (daemonNames.length === 0) {
    return {
      changedFiles: context.changedFiles,
      specs,
      routedDaemons: filteredRoutedDaemons,
      outcomes: [],
      summary: ["Changed files: 0", "Daemons: none", "", "No matching daemons for this diff."].join("\n"),
      blockingFailures: [],
      proposalArtifacts: null,
    };
  }

  for (const routed of filteredRoutedDaemons) {
    const spec = specByName.get(routed.name);
    if (!spec) {
      throw new Error(`missing daemon spec for ${routed.name}`);
    }
    await syncTrustedDaemonIntoReviewRoot(spec, context.trustedRoot, context.reviewRoot);
  }

  const outcomes = await runDaemonsInParallel(
    filteredRoutedDaemons,
    specByName,
    context.trustedRoot,
    context.reviewRoot,
  );
  const edits = outcomes
    .filter((outcome) => outcome.ok && outcome.diff.trim().length > 0)
    .map((outcome) => ({
      daemonName: outcome.name,
      diff: outcome.diff,
      filesTouched: filesTouchedFromDiff(outcome.diff),
    }));

  return {
    changedFiles: context.changedFiles,
    specs,
    routedDaemons: filteredRoutedDaemons,
    outcomes,
    summary: buildSummary(context.changedFiles, daemonNames, outcomes),
    blockingFailures: blockingOutcomes(outcomes),
    proposalArtifacts: edits.length > 0 ? { edits } : null,
  };
}

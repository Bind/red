import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { type DaemonSpec } from "../../../../pkg/daemons/src/index";
import type { WorkflowObserver } from "../../../observability";
import { reviewParallelism, type RoutedDaemon } from "./routing";
import type { DaemonOutcome } from "./types";

export type DaemonExecutorInstance = {
  run(input: {
    spec: DaemonSpec;
    trustedRoot: string;
    reviewRoot: string;
    relevantFiles: string[];
    observer?: WorkflowObserver;
  }): Promise<DaemonOutcome>;
};

export async function copyTrustedDaemonSpecIntoReviewCodebase(
  spec: DaemonSpec,
  trustedRoot: string,
  reviewRoot: string,
): Promise<void> {
  const rel = relative(trustedRoot, spec.file);
  const dest = join(reviewRoot, rel);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, await readFile(spec.file));
}

function renderFilesTouched(diff: string): number {
  const filesTouched = new Set<string>();
  for (const line of diff.split("\n")) {
    const match = line.match(/^\+\+\+ (?:(?:b\/)?(.+)|\/dev\/null)$/);
    if (match?.[1]) filesTouched.add(match[1]);
    const binaryMatch = line.match(/^Binary files (?:a\/)?(.+) and (?:b\/)?(.+) differ$/);
    if (binaryMatch) filesTouched.add(binaryMatch[2]);
  }
  return filesTouched.size;
}

export function renderOutcome(outcome: DaemonOutcome): string {
  const lines = [`### ${outcome.name}`];
  if (!outcome.ok) {
    lines.push(`- status: failed`);
    lines.push(`- reason: ${outcome.reason ?? "unknown"}`);
    lines.push(`- message: ${outcome.message ?? "daemon failed"}`);
    return lines.join("\n");
  }

  lines.push(`- status: completed`);
  lines.push(`- summary: ${outcome.summary}`);
  if (outcome.findings.length === 0) {
    lines.push(`- findings: none`);
    return lines.join("\n");
  }

  lines.push(`- findings:`);
  for (const finding of outcome.findings) {
    const target = finding.target ? ` (${finding.target})` : "";
    const note = finding.note ? `: ${finding.note}` : "";
    lines.push(`  - ${finding.invariant}${target} -> ${finding.status}${note}`);
  }
  if (outcome.diff.length > 0) {
    lines.push(`- edits: ${renderFilesTouched(outcome.diff)} file(s) touched`);
  }
  return lines.join("\n");
}

export async function runRoutedDaemons(
  routedDaemons: RoutedDaemon[],
  specByName: Map<string, DaemonSpec>,
  trustedRoot: string,
  reviewRoot: string,
  executor: DaemonExecutorInstance,
  observer?: WorkflowObserver,
): Promise<DaemonOutcome[]> {
  const outcomes = new Array<DaemonOutcome>(routedDaemons.length);
  const parallelism = reviewParallelism(routedDaemons.length);
  let nextIndex = 0;
  const errors: Error[] = [];

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex++;
      if (index >= routedDaemons.length) return;
      const routed = routedDaemons[index];
      const spec = specByName.get(routed.name);
      if (!spec) {
        errors.push(new Error(`missing daemon spec for ${routed.name}`));
        continue;
      }
      try {
        outcomes[index] = await executor.run({
          spec,
          trustedRoot,
          reviewRoot,
          relevantFiles: routed.relevantFiles,
          observer,
        });
      } catch (error) {
        errors.push(
          error instanceof Error
            ? error
            : new Error(`daemon ${routed.name} failed: ${String(error)}`),
        );
      }
    }
  }

  await Promise.all(Array.from({ length: parallelism }, () => worker()));
  if (errors.length > 0) {
    throw new AggregateError(errors, `failed to run ${errors.length} daemon review task(s)`);
  }
  return outcomes;
}

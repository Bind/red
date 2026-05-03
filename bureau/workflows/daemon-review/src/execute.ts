import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { type DaemonSpec } from "../../../../pkg/daemons/src/index";
import { reviewParallelism, type RoutedDaemon } from "./routing";
import type { DaemonOutcome } from "./types";

export type DaemonExecutorInstance = {
  run(input: {
    spec: DaemonSpec;
    trustedRoot: string;
    reviewRoot: string;
    relevantFiles: string[];
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
    const match = line.match(/^\+\+\+ b\/(.+)$/);
    if (match) filesTouched.add(match[1]);
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
): Promise<DaemonOutcome[]> {
  const outcomes = new Array<DaemonOutcome>(routedDaemons.length);
  const parallelism = reviewParallelism(routedDaemons.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (true) {
      const index = nextIndex;
      if (index >= routedDaemons.length) return;
      nextIndex += 1;
      const routed = routedDaemons[index];
      const spec = specByName.get(routed.name);
      if (!spec) {
        throw new Error(`missing daemon spec for ${routed.name}`);
      }
      outcomes[index] = await executor.run({
        spec,
        trustedRoot,
        reviewRoot,
        relevantFiles: routed.relevantFiles,
      });
    }
  }

  await Promise.all(Array.from({ length: parallelism }, () => worker()));
  return outcomes;
}

#!/usr/bin/env bun

import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

type ArtifactSummary = {
  generatedAt: string;
  baseRef: string;
  headRef: string;
  changedFiles: string[];
};

async function latestRunDir(root: string): Promise<string | null> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const dirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort().reverse();
    return dirs.length > 0 ? join(root, dirs[0]!) : null;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const root = resolve(process.cwd(), process.env.DAEMON_REVIEW_LOCAL_OUTPUT_DIR ?? ".daemons-artifacts/local-review");
  const runDir = await latestRunDir(root);
  if (!runDir) {
    console.log("No local daemon review artifacts found.");
    return;
  }

  const summary = JSON.parse(await readFile(join(runDir, "artifacts.json"), "utf8")) as ArtifactSummary;
  const outcomesDir = join(runDir, "outcomes");
  const outcomeFiles = (await readdir(outcomesDir)).filter((name) => name.endsWith(".json")).sort();

  console.log(`# Local Daemon Review`);
  console.log(`Run dir: ${runDir}`);
  console.log(`Generated: ${summary.generatedAt}`);
  console.log(`Base: ${summary.baseRef}`);
  console.log(`Head: ${summary.headRef}`);
  console.log(`Changed files: ${summary.changedFiles.join(", ") || "(none)"}`);

  for (const file of outcomeFiles) {
    const outcome = JSON.parse(await readFile(join(outcomesDir, file), "utf8")) as {
      name: string;
      runId: string;
      ok: boolean;
      turns: number;
      tokens: { input: number; output: number };
      viewedFiles: string[];
      changedFiles: string[];
      initialMemory: {
        snapshotCommit: string | null;
        currentCommit: string | null;
        trackedSubjects: string[];
        staleTrackedSubjects: string[];
        checkedFiles: string[];
      } | null;
    };
    console.log(`\n## ${outcome.name}`);
    console.log(`Session: ${outcome.runId}`);
    console.log(`Status: ${outcome.ok ? "ok" : "failed"}`);
    console.log(`Turns: ${outcome.turns}`);
    console.log(`Tokens: ${outcome.tokens.input} in / ${outcome.tokens.output} out`);
    console.log(`Viewed files: ${outcome.viewedFiles.join(", ") || "(none)"}`);
    console.log(`Changed files: ${outcome.changedFiles.join(", ") || "(none)"}`);
    if (outcome.initialMemory) {
      console.log(`Initial memory snapshot: ${outcome.initialMemory.snapshotCommit ?? "none"}`);
      console.log(`Current commit: ${outcome.initialMemory.currentCommit ?? "unknown"}`);
      console.log(`Tracked subjects: ${outcome.initialMemory.trackedSubjects.join(", ") || "(none)"}`);
      console.log(`Stale subjects: ${outcome.initialMemory.staleTrackedSubjects.join(", ") || "(none)"}`);
      console.log(`Previously checked: ${outcome.initialMemory.checkedFiles.join(", ") || "(none)"}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

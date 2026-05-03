#!/usr/bin/env bun

import { loadDaemons } from "../../../../pkg/daemons/src/index";
import { evaluateRouting } from "./routing";
import { ROUTING_TRAINING_SET } from "./training-set";

function expectedForFile(expectedByFile: Record<string, string[]>, file: string): string[] {
  return [...(expectedByFile[file] ?? [])].sort((a, b) => a.localeCompare(b));
}

function formatMemorySummary(memoryByDaemon?: Record<string, { dependencyFiles: string[]; checkedFiles: string[] }>): string {
  if (!memoryByDaemon) return "none";
  const entries = Object.entries(memoryByDaemon).map(([daemonName, memory]) => {
    return `${daemonName}(dep=${memory.dependencyFiles.length},checked=${memory.checkedFiles.length})`;
  });
  return entries.join("; ");
}

async function main() {
  const { specs, errors } = await loadDaemons(process.cwd());
  if (errors.length > 0) {
    throw new Error(errors.map((error) => `${error.file}: ${error.message}`).join("\n"));
  }

  for (const scenario of ROUTING_TRAINING_SET) {
    const evaluation = await evaluateRouting(scenario.files, specs, {
      memoryByDaemon: scenario.memoryByDaemon ? new Map(Object.entries(scenario.memoryByDaemon)) : undefined,
    });
    console.log(`SCENARIO ${scenario.name}`);
    console.log(`MEMORY ${formatMemorySummary(scenario.memoryByDaemon)}`);
    console.log(JSON.stringify(evaluation.routedDaemons, null, 2));
    for (const file of evaluation.fileDebug) {
      console.log(`FILE ${file.file}`);
      console.log(`  mode: ${file.mode}`);
      console.log(`  expected: ${expectedForFile(scenario.expectedByFile, file.file).join(", ") || "(none)"}`);
      console.log(`  selected: ${file.selectedDaemons.join(", ") || "(none)"}`);
      if (file.librarianRationale) {
        console.log(`  librarian: ${file.librarianRationale} (${file.librarianConfidence?.toFixed(2) ?? "n/a"})`);
      }
      for (const score of file.scores.slice(0, 4)) {
        console.log(
          `  score ${score.daemonName}: semantic=${score.semanticScore.toFixed(3)} boost=${score.scoreBoost.toFixed(3)} final=${score.finalScore.toFixed(3)} selected=${score.selected} dep=${score.dependencyExact} checked=${score.checkedExact} neighbor=${score.pathNeighborScore.toFixed(3)}`,
        );
      }
    }
  }
}

await main();

#!/usr/bin/env bun
import { describeExperimentApi } from "./index";

type Command = "list" | "describe";

const USAGE = `Usage:
  bun run src/manual.ts list
  bun run src/manual.ts describe
`;

function parseArgs(argv: string[]): Command {
  const command = (argv[0] ?? "list") as Command;
  if (command !== "list" && command !== "describe") {
    throw new Error(`Unknown command: ${command}`);
  }
  return command;
}

function printList() {
  console.log("git-sdk-lab commands");
  console.log("");
  console.log("  list       Show available commands");
  console.log("  describe   Print the current SDK experiment shape");
}

function printDescribe() {
  console.log(JSON.stringify(describeExperimentApi(), null, 2));
}

function main(argv: string[]) {
  const command = parseArgs(argv);
  if (command === "list") {
    printList();
    return;
  }
  printDescribe();
}

try {
  main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(USAGE);
  process.exit(1);
}

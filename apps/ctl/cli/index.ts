#!/usr/bin/env bun
import { statusCommand } from "./status";

const USAGE = `red — agent-native code forge

Usage:
  red status              Show summary throughput and pending reviews
  red help                Show this help message

Options:
  --api-url <url>   API base URL (default: http://localhost:3000, env: RED_API_URL)
  --format <fmt>    Output format: text | json (default: text)
`;

export interface CliContext {
  apiUrl: string;
  format: "text" | "json";
  args: string[];
}

function writeStdout(line: string): void {
  process.stdout.write(`${line}\n`);
}

function writeStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

export function parseArgs(argv: string[]): CliContext {
  const args: string[] = [];
  let apiUrl = process.env.RED_API_URL ?? "http://localhost:3000";
  let format: "text" | "json" = "text";

  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--api-url" && argv[i + 1]) {
      apiUrl = argv[++i];
    } else if (argv[i] === "--format" && argv[i + 1]) {
      const f = argv[++i];
      if (f === "json" || f === "text") format = f;
    } else if (!argv[i].startsWith("--")) {
      args.push(argv[i]);
    }
  }

  return { apiUrl: apiUrl.replace(/\/+$/, ""), format, args };
}

export function run(argv: string[]): Promise<number> {
  const ctx = parseArgs(argv);
  const [command] = ctx.args;

  switch (command) {
    case "status":
      return statusCommand(ctx);

    case "help":
    case undefined:
      writeStdout(USAGE);
      return Promise.resolve(0);

    default:
      writeStderr(`Unknown command: ${command}`);
      writeStderr(USAGE);
      return Promise.resolve(1);
  }
}

// Entry point
if (import.meta.main) {
  const code = await run(process.argv.slice(2));
  process.exit(code);
}

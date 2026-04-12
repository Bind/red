#!/usr/bin/env bun
import { statusCommand } from "./status";

const USAGE = `redc — agent-native code forge

Usage:
  redc status              Show summary throughput and pending reviews
  redc help                Show this help message

Options:
  --api-url <url>   API base URL (default: http://localhost:3000, env: REDC_API_URL)
  --format <fmt>    Output format: text | json (default: text)
`;

export interface CliContext {
  apiUrl: string;
  format: "text" | "json";
  args: string[];
}

export function parseArgs(argv: string[]): CliContext {
  const args: string[] = [];
  let apiUrl = process.env.REDC_API_URL ?? "http://localhost:3000";
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

export async function run(argv: string[]): Promise<number> {
  const ctx = parseArgs(argv);
  const [command] = ctx.args;

  switch (command) {
    case "status":
      return statusCommand(ctx);

    case "help":
    case undefined:
      console.log(USAGE);
      return 0;

    default:
      console.error(`Unknown command: ${command}`);
      console.error(USAGE);
      return 1;
  }
}

// Entry point
if (import.meta.main) {
  const code = await run(process.argv.slice(2));
  process.exit(code);
}

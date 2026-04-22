#!/usr/bin/env bun
import { relative } from "node:path";
import { loadDaemons, resolveDaemon } from "./loader";
import { runDaemon } from "./runner";

function usage(): never {
  process.stderr.write(
    [
      "redc-daemons — run markdown-defined AI daemons",
      "",
      "  redc-daemons list [--root <dir>]",
      "  redc-daemons show <name> [--root <dir>]",
      "  redc-daemons run  <name> [--root <dir>] [--input <text>] [--max-turns N] [--max-ms N]",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

type ParsedArgs = {
  command: "list" | "show" | "run";
  name?: string;
  root?: string;
  input?: string;
  maxTurns?: number;
  maxMs?: number;
};

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  if (command !== "list" && command !== "show" && command !== "run") usage();

  const out: ParsedArgs = { command };
  let i = 0;
  while (i < rest.length) {
    const arg = rest[i];
    if (arg === "--root") {
      out.root = rest[++i];
    } else if (arg === "--input") {
      out.input = rest[++i];
    } else if (arg === "--max-turns") {
      out.maxTurns = Number.parseInt(rest[++i] ?? "", 10);
    } else if (arg === "--max-ms") {
      out.maxMs = Number.parseInt(rest[++i] ?? "", 10);
    } else if (arg && !arg.startsWith("--") && out.name === undefined) {
      out.name = arg;
    } else {
      usage();
    }
    i += 1;
  }

  if ((command === "show" || command === "run") && !out.name) usage();
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "list") {
    const { specs, errors } = await loadDaemons(args.root);
    for (const s of specs) {
      const rel = relative(process.cwd(), s.file);
      process.stdout.write(`${s.name.padEnd(32)}  ${rel}\n  ${s.description}\n\n`);
    }
    for (const e of errors) {
      process.stderr.write(`ERROR ${e.file}: ${e.message}\n`);
    }
    process.exit(errors.length > 0 ? 1 : 0);
  }

  if (args.command === "show") {
    const spec = await resolveDaemon(args.name!, args.root);
    process.stdout.write(
      [
        `name:        ${spec.name}`,
        `description: ${spec.description}`,
        `file:        ${relative(process.cwd(), spec.file)}`,
        `scope:       ${relative(process.cwd(), spec.scopeRoot) || "."}`,
        "",
        "--- body ---",
        spec.body,
        "",
      ].join("\n"),
    );
    return;
  }

  const result = await runDaemon(args.name!, {
    root: args.root,
    input: args.input,
    maxTurns: args.maxTurns,
    maxWallclockMs: args.maxMs,
  });

  if (result.ok) {
    process.stderr.write(
      `\ndaemon ${result.daemon} completed in ${result.turns} turn(s). tokens: ${result.tokens.input} in / ${result.tokens.output} out\n`,
    );
    process.stdout.write(`${JSON.stringify(result.payload, null, 2)}\n`);
    return;
  }

  process.stderr.write(
    `\ndaemon ${result.daemon} FAILED: ${result.reason} — ${result.message}\n`,
  );
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
  process.exit(1);
});

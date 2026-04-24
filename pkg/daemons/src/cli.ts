#!/usr/bin/env bun
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { relative } from "node:path";
import { defaultCodexAuthPath, loginAndStoreCodexAuth } from "./auth";
import { loadDaemons, resolveDaemon } from "./loader";
import { runDaemon } from "./runner";

function usage(): never {
  process.stderr.write(
    [
      "redc-daemons — markdown-authored AI daemons",
      "",
      "  redc-daemons auth [--store <path>]",
      "      Run the ChatGPT / Codex OAuth flow and store credentials.",
      "      Default store: ~/.codex/auth.json (interoperable with `codex login`).",
      "",
      "  redc-daemons run <name> [--root <dir>] [--input <text>]",
      "                         [--max-turns N] [--max-ms N]",
      "      Invoke a daemon once. Emits JSONL wide-events on stdout,",
      "      prints the complete payload on success.",
      "",
      "  redc-daemons list [--root <dir>]",
      "      Walk *.daemon.md under the root.",
      "",
      "  redc-daemons show <name> [--root <dir>]",
      "      Print the resolved frontmatter, body, and scope of a daemon.",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

type Command = "auth" | "run" | "list" | "show";

type ParsedArgs = {
  command: Command;
  name?: string;
  root?: string;
  input?: string;
  maxTurns?: number;
  maxMs?: number;
  store?: string;
};

function parseArgs(argv: string[]): ParsedArgs {
  const [rawCommand, ...rest] = argv;
  const allowed: Command[] = ["auth", "run", "list", "show"];
  if (!rawCommand || !allowed.includes(rawCommand as Command)) usage();
  const command = rawCommand as Command;

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
    } else if (arg === "--store") {
      out.store = rest[++i];
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

async function authCommand(args: ParsedArgs): Promise<number> {
  const authPath = args.store ?? defaultCodexAuthPath();
  const rl = createInterface({ input, output });
  try {
    await loginAndStoreCodexAuth({
      authPath,
      onAuth(info) {
        process.stderr.write(
          `\nOpen this URL in your browser to authorize:\n  ${info.url}\n`,
        );
        if (info.instructions) {
          process.stderr.write(`\n${info.instructions}\n`);
        }
        process.stderr.write("\n");
      },
      onProgress(message) {
        process.stderr.write(`  → ${message}\n`);
      },
      onPrompt: (prompt) => rl.question(`${prompt.message}: `),
      onManualCodeInput: () => rl.question("Paste authorization code here: "),
    });
  } finally {
    rl.close();
  }

  process.stderr.write(`\nAuthorized. Credentials stored at ${authPath}\n`);
  return 0;
}

async function listCommand(args: ParsedArgs): Promise<number> {
  const { specs, errors } = await loadDaemons(args.root);
  for (const s of specs) {
    const rel = relative(process.cwd(), s.file);
    process.stdout.write(`${s.name.padEnd(32)}  ${rel}\n  ${s.description}\n\n`);
  }
  for (const e of errors) {
    process.stderr.write(`ERROR ${e.file}: ${e.message}\n`);
  }
  return errors.length > 0 ? 1 : 0;
}

async function showCommand(args: ParsedArgs): Promise<number> {
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
  return 0;
}

async function runCommand(args: ParsedArgs): Promise<number> {
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
    return 0;
  }

  process.stderr.write(
    `\ndaemon ${result.daemon} FAILED: ${result.reason} — ${result.message}\n`,
  );
  return 1;
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "auth":
      return authCommand(args);
    case "list":
      return listCommand(args);
    case "show":
      return showCommand(args);
    case "run":
      return runCommand(args);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack ?? err.message : String(err)}\n`);
    process.exit(1);
  });

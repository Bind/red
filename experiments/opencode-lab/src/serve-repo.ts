#!/usr/bin/env bun
import { stat } from "node:fs/promises";
import { resolve } from "node:path";

const USAGE = `Usage:
  bun run src/serve-repo.ts <repo-path> [--port <n>] [--hostname <host>] [--cors <origin>] [--username <name>] [--password <value>]
`;

function parseArgs(argv: string[]) {
  const args = [...argv];
  const repoPath = args.shift();
  if (!repoPath) {
    throw new Error("Missing repo path");
  }

  let port = "4096";
  let hostname = "127.0.0.1";
  const cors: string[] = [];
  let username = process.env.OPENCODE_SERVER_USERNAME;
  let password = process.env.OPENCODE_SERVER_PASSWORD;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const value = args[i + 1];
    if (!value) {
      throw new Error(`Missing value for ${arg}`);
    }
    switch (arg) {
      case "--port":
        port = value;
        break;
      case "--hostname":
        hostname = value;
        break;
      case "--cors":
        cors.push(value);
        break;
      case "--username":
        username = value;
        break;
      case "--password":
        password = value;
        break;
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
    i++;
  }

  return {
    repoPath: resolve(repoPath),
    port,
    hostname,
    cors,
    username,
    password,
  };
}

async function main(argv: string[]) {
  const { repoPath, port, hostname, cors, username, password } = parseArgs(argv);
  const info = await stat(repoPath);
  if (!info.isDirectory()) {
    throw new Error(`${repoPath} is not a directory`);
  }

  const args = ["serve", "--port", port, "--hostname", hostname];
  for (const origin of cors) {
    args.push("--cors", origin);
  }

  const env = { ...process.env };
  if (username) env.OPENCODE_SERVER_USERNAME = username;
  if (password) env.OPENCODE_SERVER_PASSWORD = password;

  console.error(`Starting opencode serve in ${repoPath}`);
  console.error(`URL: http://${hostname}:${port}`);
  console.error("Repo mount model: one server process per repo/worktree");

  const proc = Bun.spawn(["opencode", ...args], {
    cwd: repoPath,
    env,
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });

  const exitCode = await proc.exited;
  return exitCode;
}

if (import.meta.main) {
  try {
    const code = await main(process.argv.slice(2));
    process.exit(code);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(USAGE);
    process.exit(1);
  }
}

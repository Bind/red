import { spawn } from "node:child_process";
import { resolve } from "node:path";
import type { FlueContext } from "@flue/sdk/client";

export const triggers = {};

type DaemonReviewPayload = {
  repoRoot?: string;
  baseRef?: string;
  headRef?: string;
  daemonName?: string;
};

function argList(payload: DaemonReviewPayload): string[] {
  const args = ["run", "workflows/daemon-review/src/local-entry.ts"];
  if (payload.baseRef) args.push("--base", payload.baseRef);
  if (payload.headRef) args.push("--head", payload.headRef);
  if (payload.daemonName) args.push("--daemon", payload.daemonName);
  return args;
}

export default async function ({ payload }: FlueContext) {
  const input = (payload ?? {}) as DaemonReviewPayload;
  const cwd = resolve(input.repoRoot ?? process.cwd());
  const args = argList(input);

  const child = spawn("bun", args, {
    cwd,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  child.stdout.on("data", (chunk) => {
    const text = chunk.toString();
    stdout += text;
    process.stdout.write(text);
  });

  child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    stderr += text;
    process.stderr.write(text);
  });

  const exitCode = await new Promise<number>((resolveExit, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolveExit(code ?? 1));
  });

  if (exitCode !== 0) {
    throw new Error(`daemon-review child exited ${exitCode}\n${stderr || stdout}`.trim());
  }

  return {
    command: ["bun", ...args],
    cwd,
    stdout,
  };
}

#!/usr/bin/env bun

export {};

type FlueRunOptions = {
  baseRef?: string;
  headRef?: string;
  daemonName?: string;
};

function parseArgs(argv: string[]): FlueRunOptions {
  const options: FlueRunOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base") {
      options.baseRef = argv[index + 1];
      index += 1;
    } else if (arg === "--head") {
      options.headRef = argv[index + 1];
      index += 1;
    } else if (arg === "--daemon") {
      options.daemonName = argv[index + 1];
      index += 1;
    }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const payload = JSON.stringify({
  baseRef: options.baseRef,
  headRef: options.headRef,
  daemonName: options.daemonName,
});

const proc = Bun.spawn({
  cmd: [
    "bunx",
    "flue",
    "run",
    "daemon-review",
    "--target",
    "node",
    "--id",
    `daemon-review-${Date.now()}`,
    "--workspace",
    ".flue",
    "--output",
    ".flue-dist",
    "--payload",
    payload,
  ],
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
});

const exitCode = await proc.exited;
process.exit(exitCode);

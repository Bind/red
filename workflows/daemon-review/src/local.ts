import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { cp } from "node:fs/promises";
import { runReviewExecution } from "./core";
import { localReviewLogger } from "./logger";
import type { ReviewExecutionContext } from "./types";

function writeStdout(message: string): void {
  process.stdout.write(`${message}\n`);
}

async function runGit(
  cwd: string,
  args: string[],
): Promise<{ ok: true; stdout: string } | { ok: false; stdout: string; stderr: string }> {
  const proc = Bun.spawn({ cmd: ["git", ...args], cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode === 0) return { ok: true, stdout };
  return { ok: false, stdout, stderr };
}

async function gitOrThrow(cwd: string, args: string[]): Promise<string> {
  const result = await runGit(cwd, args);
  if (!result.ok) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function parseArgs(argv: string[]): { baseRef?: string; headRef?: string; daemonName?: string } {
  const options: { baseRef?: string; headRef?: string; daemonName?: string } = {};
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

async function copyRepoTree(source: string, dest: string): Promise<void> {
  await cp(source, dest, {
    recursive: true,
    filter: (path) => !path.endsWith("/.git") && !path.includes("/.git/"),
  });
}

async function localChangedFiles(repoRoot: string, baseRef: string, headRef: string): Promise<string[]> {
  const output = await gitOrThrow(repoRoot, ["diff", "--name-only", `${baseRef}...${headRef}`]);
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function defaultBaseRef(): string {
  return process.env.DAEMON_REVIEW_LOCAL_BASE ?? "origin/main";
}

function defaultHeadRef(): string {
  return process.env.DAEMON_REVIEW_LOCAL_HEAD ?? "HEAD";
}

function defaultOutputRoot(repoRoot: string): string {
  return resolve(repoRoot, process.env.DAEMON_REVIEW_LOCAL_OUTPUT_DIR ?? ".daemons-artifacts/local-review");
}

function sanitizeFileComponent(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

async function writeLocalArtifacts(
  repoRoot: string,
  baseRef: string,
  headRef: string,
  result: Awaited<ReturnType<typeof runReviewExecution>>,
): Promise<string | null> {
  const stamp = new Date().toISOString().replace(/[:]/g, "-");
  const outputDir = join(defaultOutputRoot(repoRoot), stamp);
  const patchesDir = join(outputDir, "patches");
  const eventsDir = join(outputDir, "events");
  const outcomesDir = join(outputDir, "outcomes");
  await mkdir(patchesDir, { recursive: true });
  await mkdir(eventsDir, { recursive: true });
  await mkdir(outcomesDir, { recursive: true });

  await writeFile(
    join(outputDir, "summary.md"),
    ["# Daemon Review", "", `Base: ${baseRef}`, `Head: ${headRef}`, result.summary, ""].join("\n"),
  );
  await writeFile(
    join(outputDir, "artifacts.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        baseRef,
        headRef,
        changedFiles: result.changedFiles,
        proposalArtifacts: result.proposalArtifacts,
      },
      null,
      2,
    ),
  );

  if (result.proposalArtifacts) {
    for (const edit of result.proposalArtifacts.edits) {
      await writeFile(join(patchesDir, `${sanitizeFileComponent(edit.daemonName)}.patch`), edit.diff);
    }
  }

  for (const outcome of result.outcomes) {
    await writeFile(
      join(outcomesDir, `${sanitizeFileComponent(outcome.name)}.json`),
      JSON.stringify(outcome, null, 2),
    );
    await writeFile(
      join(eventsDir, `${sanitizeFileComponent(outcome.name)}.jsonl`),
      outcome.wideEvents.map((event) => JSON.stringify(event)).join("\n") + (outcome.wideEvents.length ? "\n" : ""),
    );
  }

  return outputDir;
}

export async function runLocalDaemonReview(argv = process.argv.slice(2)): Promise<void> {
  const repoRoot = resolve(process.cwd());
  const { baseRef = defaultBaseRef(), headRef = defaultHeadRef(), daemonName } = parseArgs(argv);
  const changedFiles = await localChangedFiles(repoRoot, baseRef, headRef);
  const reviewRoot = await mkdtemp(join(tmpdir(), "daemon-review-local-"));
  try {
    await copyRepoTree(repoRoot, reviewRoot);
    const context: ReviewExecutionContext = {
      trustedRoot: repoRoot,
      reviewRoot,
      changedFiles,
      daemonName,
      daemonLimit: daemonName ? undefined : 1,
    };
    localReviewLogger.info("starting local daemon review", {
      baseRef,
      headRef,
      changedFiles,
      daemon: daemonName ?? "(first routed daemon only)",
    });
    writeStdout("# Local Daemon Review");
    writeStdout(`Base: ${baseRef}`);
    writeStdout(`Head: ${headRef}`);
    writeStdout(`Daemon: ${daemonName ?? "(first routed daemon only)"}`);
    writeStdout(`Changed files: ${changedFiles.join(", ") || "(none)"}`);
    writeStdout("");
    writeStdout("Running...");
    const result = await runReviewExecution(context);
    writeStdout("");
    writeStdout(`Selected daemon(s): ${result.routedDaemons.map((entry) => entry.name).join(", ") || "(none)"}`);
    localReviewLogger.info("local daemon review summary\n{summary}", {
      summary: [
        "# Daemon Review",
        "",
        `Base: ${baseRef}`,
        `Head: ${headRef}`,
        `Daemon: ${daemonName ?? "(first routed daemon only)"}`,
        result.summary,
      ].join("\n"),
    });
    const artifactsDir = await writeLocalArtifacts(repoRoot, baseRef, headRef, result);
    if (artifactsDir) {
      localReviewLogger.info("daemon edits were written to {dir}", { dir: artifactsDir });
      writeStdout(`Artifacts: ${artifactsDir}`);
    }
    if (result.blockingFailures.length > 0) {
      process.exit(1);
    }
  } finally {
    await rm(reviewRoot, { recursive: true, force: true });
  }
}

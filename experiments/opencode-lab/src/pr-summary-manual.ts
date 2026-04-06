#!/usr/bin/env bun
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { homedir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { buildSummaryPrompt } from "../../../apps/api/engine/tasks/summary";
import { validateSummaryOutput } from "../../../apps/api/engine/tasks/summary";
import type { ConfidenceLevel, DiffStats, FileStats, LLMSummary } from "../../../apps/api/types";

interface Options {
  repoUrl: string;
  repoLabel: string;
  branch: string;
  baseRef: string;
  headRef: string;
  confidence: ConfidenceLevel;
  outDir: string;
  model: string;
  keepRepo: boolean;
  timeoutMs: number;
  driver: "serve" | "run";
}

const USAGE = `Usage:
  bun src/pr-summary-manual.ts --repo-url <url> --base-ref <ref> --head-ref <ref> --out-dir <path> [--repo-label <owner/repo>] [--branch <name>] [--confidence <safe|needs_review|critical>] [--model <provider/model>] [--timeout-ms <ms>] [--driver <serve|run>] [--keep-repo]
`;

function parseArgs(argv: string[]): Options {
  const options: Record<string, string> = {};
  const flags = new Set<string>();

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    const key = arg.slice(2);
    if (key === "keep-repo") {
      flags.add(key);
      continue;
    }
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    options[key] = value;
    i++;
  }

  const repoUrl = options["repo-url"];
  const baseRef = options["base-ref"];
  const headRef = options["head-ref"];
  const outDir = options["out-dir"];
  if (!repoUrl || !baseRef || !headRef || !outDir) {
    throw new Error("Missing required flags");
  }

  return {
    repoUrl,
    repoLabel: options["repo-label"] ?? inferRepoLabel(repoUrl),
    branch: options["branch"] ?? headRef,
    baseRef,
    headRef,
    confidence: parseConfidence(options["confidence"] ?? "needs_review"),
    outDir: resolve(outDir),
    model: options["model"] ?? "openai/gpt-5.4",
    keepRepo: flags.has("keep-repo"),
    timeoutMs: parseTimeout(options["timeout-ms"] ?? "90000"),
    driver: parseDriver(options["driver"] ?? "serve"),
  };
}

function parseTimeout(input: string) {
  const value = Number.parseInt(input, 10);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid timeout "${input}"`);
  }
  return value;
}

function parseDriver(input: string): "serve" | "run" {
  if (input === "serve" || input === "run") {
    return input;
  }
  throw new Error(`Invalid driver "${input}"`);
}

function inferRepoLabel(repoUrl: string): string {
  const normalized = repoUrl.replace(/\/+$/, "").replace(/\.git$/, "");
  return basename(normalized);
}

function parseConfidence(value: string): ConfidenceLevel {
  if (value === "safe" || value === "needs_review" || value === "critical") {
    return value;
  }
  throw new Error(`Invalid confidence "${value}"`);
}

async function run(cmd: string[], cwd?: string): Promise<string> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    throw new Error(`Command failed (${cmd.join(" ")}): ${stderr || stdout}`);
  }

  return stdout.trim();
}

async function cloneRepo(opts: Options, repoDir: string) {
  await run(["git", "clone", "--no-checkout", opts.repoUrl, repoDir]);
  await run(["git", "fetch", "origin", `${opts.baseRef}:refs/remotes/origin/__redc_base`], repoDir);
  await run(["git", "fetch", "origin", `${opts.headRef}:refs/remotes/origin/__redc_head`], repoDir);
  await run(["git", "checkout", "--detach", "refs/remotes/origin/__redc_head"], repoDir);
}

async function buildDiffStats(repoDir: string): Promise<DiffStats> {
  const range = "refs/remotes/origin/__redc_base...HEAD";
  const nameStatus = await run(["git", "diff", "--find-renames", "--name-status", range], repoDir);
  const numstat = await run(["git", "diff", "--find-renames", "--numstat", range], repoDir);

  const fileMap = new Map<string, FileStats>();

  for (const line of nameStatus.split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    const code = parts[0] ?? "";

    if (code.startsWith("R")) {
      const newPath = parts[2];
      if (!newPath) continue;
      fileMap.set(newPath, {
        filename: newPath,
        additions: 0,
        deletions: 0,
        status: "renamed",
      });
      continue;
    }

    const path = parts[1];
    if (!path) continue;
    fileMap.set(path, {
      filename: path,
      additions: 0,
      deletions: 0,
      status: mapStatus(code),
    });
  }

  for (const line of numstat.split("\n").filter(Boolean)) {
    const [additionsRaw, deletionsRaw, rawPath] = line.split("\t");
    if (!rawPath) continue;
    const path = normalizeNumstatPath(rawPath);
    const current = fileMap.get(path) ?? {
      filename: path,
      additions: 0,
      deletions: 0,
      status: "modified" as const,
    };
    current.additions = additionsRaw === "-" ? 0 : Number.parseInt(additionsRaw, 10);
    current.deletions = deletionsRaw === "-" ? 0 : Number.parseInt(deletionsRaw, 10);
    fileMap.set(path, current);
  }

  const files = [...fileMap.values()].sort((a, b) => a.filename.localeCompare(b.filename));
  return {
    files_changed: files.length,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    files,
  };
}

function mapStatus(code: string): FileStats["status"] {
  switch (code[0]) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    default:
      return "modified";
  }
}

function normalizeNumstatPath(raw: string): string {
  if (!raw.includes(" => ")) return raw;
  if (raw.includes("{") && raw.includes("}")) {
    return raw.replace(/\{([^{}]*?) => ([^{}]*?)\}/g, "$2");
  }
  return raw.split(" => ").pop() ?? raw;
}

async function getCommitMessages(repoDir: string): Promise<string[]> {
  const output = await run(
    ["git", "log", "--format=%s", "refs/remotes/origin/__redc_base..HEAD"],
    repoDir
  );
  return output.split("\n").map((line) => line.trim()).filter(Boolean);
}

async function buildComparisonContext(repoDir: string): Promise<string> {
  const range = "refs/remotes/origin/__redc_base...HEAD";
  const stat = await run(["git", "diff", "--find-renames", "--stat", range], repoDir);
  const nameStatus = await run(["git", "diff", "--find-renames", "--name-status", range], repoDir);
  const diff = await run(
    ["git", "diff", "--find-renames", "--unified=2", "--no-ext-diff", range],
    repoDir
  );

  const maxDiffChars = 120_000;
  const truncatedDiff =
    diff.length > maxDiffChars
      ? `${diff.slice(0, maxDiffChars)}\n\n[diff truncated after ${maxDiffChars} chars]`
      : diff;

  return [
    "Comparison context generated by the harness.",
    "Use this context as the primary source of truth.",
    "",
    "## git diff --stat",
    stat,
    "",
    "## git diff --name-status",
    nameStatus,
    "",
    "## git diff --unified=2",
    truncatedDiff,
  ].join("\n");
}

function extractJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    throw new Error("No JSON object found in assistant response");
  }
  return JSON.parse(text.slice(start, end + 1));
}

function buildSummarySystemPrompt() {
  return [
    "You are generating a redc PR summary from a prepared git comparison.",
    "Do not delegate to other agents or parallel tasks.",
    "Do not describe your plan, thoughts, or next steps.",
    "Prefer the provided comparison context over running additional tools.",
    "Return exactly one JSON object that matches the provided schema.",
    "Do not wrap the JSON in markdown or add any surrounding text.",
  ].join(" ");
}

function buildSummarySchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "title",
      "what_changed",
      "risk_assessment",
      "affected_modules",
      "recommended_action",
      "annotations",
    ],
    properties: {
      title: { type: "string" },
      what_changed: { type: "string" },
      risk_assessment: { type: "string" },
      affected_modules: {
        type: "array",
        items: { type: "string" },
      },
      recommended_action: {
        type: "string",
        enum: ["approve", "review", "block"],
      },
      annotations: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["text", "files", "type"],
          properties: {
            text: { type: "string" },
            files: {
              type: "array",
              items: { type: "string" },
            },
            type: {
              type: "string",
              enum: ["new_module", "refactor", "bugfix", "config", "change"],
            },
          },
        },
      },
    },
  };
}

function buildReviewOnlyConfig() {
  return {
    $schema: "https://opencode.ai/config.json",
    permission: {
      "*": "allow",
      bash: "deny",
      edit: "deny",
      webfetch: "deny",
    },
  };
}

async function main(argv: string[]) {
  const opts = parseArgs(argv);
  await mkdir(opts.outDir, { recursive: true });

  const worktreeRoot = resolve(homedir(), ".redc-opencode-lab-worktrees");
  await mkdir(worktreeRoot, { recursive: true });
  const repoDir = await mkdtemp(resolve(worktreeRoot, "pr-summary-"));
  await cloneRepo(opts, repoDir);
  await writeFile(resolve(repoDir, "opencode.json"), JSON.stringify(buildReviewOnlyConfig(), null, 2), "utf8");

  const diffStats = await buildDiffStats(repoDir);
  const commitMessages = await getCommitMessages(repoDir);
  const comparisonContext = await buildComparisonContext(repoDir);
  const prompt = [
    buildSummaryPrompt({
      repo: opts.repoLabel,
      branch: opts.branch,
      baseRef: "__redc_base",
      diff: "",
      diffStats,
      confidence: opts.confidence,
      commitMessages,
      headRef: opts.headRef,
    }),
    "",
    "Use the comparison context below instead of narrating your workflow.",
    "Base your answer on the actual diff content and changed file list.",
    "",
    comparisonContext,
  ].join("\n");

  const promptFile = resolve(opts.outDir, "prompt.txt");
  const schemaFile = resolve(opts.outDir, "summary.schema.json");
  const eventsFile = resolve(opts.outDir, "session-events.jsonl");
  const messagesFile = resolve(opts.outDir, "session-messages.json");
  const responseFile = resolve(opts.outDir, "assistant-response.txt");
  const metaFile = resolve(opts.outDir, "input.json");
  const summaryFile = resolve(opts.outDir, "summary.json");

  await writeFile(promptFile, prompt, "utf8");
  await writeFile(schemaFile, JSON.stringify(buildSummarySchema(), null, 2), "utf8");
  await writeFile(metaFile, JSON.stringify({
    repoUrl: opts.repoUrl,
    repoLabel: opts.repoLabel,
    worktreeDir: repoDir,
    branch: opts.branch,
    baseRef: opts.baseRef,
    headRef: opts.headRef,
    confidence: opts.confidence,
    diffStats,
    commitMessages,
    comparisonContext,
    promptFile,
    schemaFile,
    system: buildSummarySystemPrompt(),
    timeoutMs: opts.timeoutMs,
  }, null, 2), "utf8");

  const rootDir = resolve(import.meta.dir, "../../..");
  const captureScript = resolve(rootDir, "experiments/opencode-lab/container/run-serve-capture.sh");
  const containerRunScript = resolve(rootDir, "experiments/opencode-lab/container/run-in-container.sh");
  const output =
    opts.driver === "serve"
      ? await run([
          captureScript,
          "--repo-path", repoDir,
          "--prompt-file", promptFile,
          "--out-file", eventsFile,
          "--messages-file", messagesFile,
          "--response-file", responseFile,
          "--schema-file", schemaFile,
          "--model", opts.model,
          "--system", buildSummarySystemPrompt(),
          "--timeout-ms", String(opts.timeoutMs),
        ], rootDir)
      : await run([
          containerRunScript,
          "--repo-path", repoDir,
          "--prompt-file", promptFile,
          "--model", opts.model,
        ], rootDir);

  if (opts.driver === "run") {
    await writeFile(eventsFile, output, "utf8");
    const responseText = extractAssistantTextFromRunOutput(output);
    await writeFile(responseFile, responseText, "utf8");
  }

  const responseText = await readFile(responseFile, "utf8");
  const summary = validateSummaryOutput(extractJsonObject(responseText)) as LLMSummary;
  await writeFile(summaryFile, JSON.stringify(summary, null, 2), "utf8");

  if (!opts.keepRepo) {
    await rm(repoDir, { recursive: true, force: true });
  }

  console.log(JSON.stringify({
    outDir: opts.outDir,
    driver: opts.driver,
    eventsFile,
    messagesFile,
    responseFile,
    summaryFile,
    runOutput: opts.driver === "serve" && output ? JSON.parse(output) : null,
  }, null, 2));
}

function extractAssistantTextFromRunOutput(output: string): string {
  const textParts: string[] = [];

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const event = JSON.parse(trimmed) as Record<string, any>;
      if (event.type === "text" && typeof event.part?.text === "string") {
        textParts.push(event.part.text);
      }
    } catch {
      continue;
    }
  }

  return textParts.join("");
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.stack ?? error.message : JSON.stringify(error, null, 2));
    console.error(USAGE);
    process.exit(1);
  }
}

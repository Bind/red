#!/usr/bin/env bun
import { DockerClawRunner } from "./runner";
import type { ManualClawJob } from "./types";
import { SqliteClawRunTracker } from "./tracker";
import { clawPromptRegistry, manualClawActionMap } from "./actions";
import { getPromptPath, loadPromptTemplate } from "./prompts";
import { LocalClawArtifactStore } from "./artifacts";

const JOBS = manualClawActionMap as Map<string, ManualClawJob<unknown, unknown>>;

const USAGE = `Usage:
  bun run src/claw/manual.ts list
  bun run src/claw/manual.ts prompts
  bun run src/claw/manual.ts prompt <prompt-name>
  bun run src/claw/manual.ts runs [--limit <n>]
  bun run src/claw/manual.ts run <job> [job args] [--image <image>] [--git-base-url <url>] [--timeout-ms <ms>]

Jobs:
  summarize-change   --repo owner/repo --head <ref> [--base main]
  write-review-report --repo owner/repo --head <ref> [--base main]
  summarize-and-patch --repo owner/repo --head <ref> [--base main]
`;

function parseGlobalArgs(argv: string[]) {
  const args = [...argv];
  let image =
    process.env.OPENCODE_RUNNER_IMAGE ??
    process.env.CODEX_RUNNER_IMAGE ??
    "redc-claw-runner";
  let gitBaseUrl = process.env.GIT_STORAGE_PUBLIC_URL ?? process.env.GIT_BASE_URL;
  let timeoutMs: number | undefined;
  let limit = 20;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--image" && args[i + 1]) {
      image = args.splice(i, 2)[1];
      i--;
      continue;
    }
    if (args[i] === "--git-base-url" && args[i + 1]) {
      gitBaseUrl = args.splice(i, 2)[1];
      i--;
      continue;
    }
    if (args[i] === "--timeout-ms" && args[i + 1]) {
      timeoutMs = parseInt(args.splice(i, 2)[1], 10);
      i--;
      continue;
    }
    if (args[i] === "--limit" && args[i + 1]) {
      limit = parseInt(args.splice(i, 2)[1], 10);
      i--;
    }
  }

  return { args, image, gitBaseUrl, timeoutMs, limit };
}

async function main(argv: string[]): Promise<number> {
  const { args, image, gitBaseUrl, timeoutMs, limit } = parseGlobalArgs(argv);
  const [command, maybeJobName, ...rest] = args;
  const tracker = new SqliteClawRunTracker();

  if (command === "list") {
    for (const job of JOBS.values()) {
      console.log(`${job.name}\t${job.description}`);
    }
    return 0;
  }

  if (command === "prompts") {
    for (const [name, promptName] of Object.entries(clawPromptRegistry)) {
      console.log(`${name}\t${getPromptPath(promptName)}`);
    }
    return 0;
  }

  if (command === "prompt") {
    if (!maybeJobName) {
      console.error(USAGE);
      return 1;
    }
    const promptName = clawPromptRegistry[maybeJobName as keyof typeof clawPromptRegistry];
    if (!promptName) {
      console.error(`Unknown prompt: ${maybeJobName}`);
      return 1;
    }
    console.log(loadPromptTemplate(promptName));
    return 0;
  }

  if (command === "runs") {
    console.log(JSON.stringify(tracker.listRecent(limit), null, 2));
    return 0;
  }

  if (command !== "run" || !maybeJobName) {
    console.error(USAGE);
    return 1;
  }

  if (!gitBaseUrl) {
    console.error("Missing GIT_STORAGE_PUBLIC_URL, GIT_BASE_URL, or --git-base-url");
    return 1;
  }

  const job = JOBS.get(maybeJobName);
  if (!job) {
    console.error(`Unknown job: ${maybeJobName}`);
    console.error(USAGE);
    return 1;
  }

  let input: unknown;
  try {
    input = job.parseCliArgs(rest);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }

  const runner = new DockerClawRunner({
    image,
    gitBaseUrl,
    openaiApiKey: process.env.OPENAI_API_KEY ?? null,
    defaultTimeoutMs: timeoutMs,
    tracker,
    artifactStore: new LocalClawArtifactStore(),
  });

  const request = job.build(input);
  if (timeoutMs != null) {
    request.timeoutMs = timeoutMs;
  }
  request.metadata = {
    ...request.metadata,
    jobName: job.name,
    jobId: request.metadata.jobId ?? `manual:${job.name}`,
  };

  const result = await runner.run({
    ...request,
    onLog: (line) => {
      console.error(line);
    },
  });

  if (!result.ok) {
    console.error(result.error?.message ?? "Claw job failed");
    return 1;
  }

  console.log(JSON.stringify({
    runId: result.runId,
    status: result.status,
    containerName: result.containerName,
    containerId: result.containerId ?? null,
    json: result.json ?? null,
    files: result.files,
    durationMs: result.durationMs,
  }, null, 2));
  return 0;
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2));
  process.exit(code);
}

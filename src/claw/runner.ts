import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type {
  ClawArtifactStore,
  ClawOutputFile,
  ClawRepoRunRequest,
  ClawRepoRunResult,
  ClawRunError,
  ClawRunRecord,
  PersistedClawArtifacts,
  ClawRunnerConfig,
} from "./types";

interface RuntimeRequestManifest {
  repo: string;
  headRef: string;
  baseRef?: string;
  instructions: string;
  setupScript?: string;
  output: {
    json?: boolean;
    files?: string[];
  };
}

interface RolloutMetadata {
  runtimeSessionId: string | null;
  rolloutPath: string | null;
}

export class DockerClawRunner {
  constructor(private config: ClawRunnerConfig) {}

  async run<TJson = unknown>(
    request: ClawRepoRunRequest<TJson>
  ): Promise<ClawRepoRunResult<TJson>> {
    const timeout = request.timeoutMs ?? this.config.defaultTimeoutMs ?? 120_000;
    const runId = request.metadata.runId ?? randomUUID();
    const containerName = buildContainerName(request.metadata.jobName, runId);
    const dockerBaseUrl = this.config.forgejoBaseUrl
      .replace(/\/+$/, "")
      .replace(/localhost|127\.0\.0\.1/, "host.docker.internal");
    const repoUrl = `${dockerBaseUrl}/${request.repo}.git`;
    const tmpRoot = await mkdtemp(join(tmpdir(), "redc-claw-job-"));
    const inputDir = join(tmpRoot, "input");
    const outputDir = join(tmpRoot, "output");
    const opencodeHomeDir = join(tmpRoot, "opencode-home");
    const cidFile = join(tmpRoot, "container.cid");
    const start = Date.now();
    const createdAt = new Date().toISOString();

    await mkdir(inputDir, { recursive: true });
    await mkdir(join(outputDir, "files"), { recursive: true });
    await mkdir(opencodeHomeDir, { recursive: true });

    const manifest: RuntimeRequestManifest = {
      repo: request.repo,
      headRef: request.headRef,
      baseRef: request.baseRef,
      instructions: request.instructions,
      setupScript: request.setupScript,
      output: request.output,
    };
    await writeFile(
      join(inputDir, "request.json"),
      JSON.stringify(manifest, null, 2),
      "utf8"
    );

    const createdRecord: ClawRunRecord = {
      runId,
      jobName: request.metadata.jobName,
      jobId: request.metadata.jobId ?? null,
      changeId: request.metadata.changeId ?? null,
      workerId: request.metadata.workerId ?? null,
      repo: request.repo,
      headRef: request.headRef,
      baseRef: request.baseRef ?? null,
      image: this.config.image,
      containerName,
      containerId: null,
      codexSessionId: null,
      rolloutPath: null,
      status: "created",
      createdAt,
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      errorType: null,
      errorMessage: null,
    };
    this.config.tracker?.create(createdRecord);

    try {
      const preflightError = await runDockerPreflightChecks(this.config.image, tmpRoot);
      if (preflightError) {
        const durationMs = Date.now() - start;
        this.config.tracker?.finish(runId, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          durationMs,
          errorType: preflightError.type,
          errorMessage: preflightError.message,
        });
        return {
          ok: false,
          runId,
          status: "failed",
          durationMs,
          logs: "",
          files: [],
          containerName,
          error: preflightError,
        };
      }

      const args = [
        "docker",
        "run",
        "--rm",
        "--name",
        containerName,
        "--cidfile",
        cidFile,
        "--label",
        `redc.run_id=${runId}`,
        "--label",
        `redc.job_name=${request.metadata.jobName}`,
        "--label",
        `redc.repo=${request.repo}`,
        "--label",
        `redc.head_ref=${request.headRef}`,
        "--label",
        `redc.base_ref=${request.baseRef ?? ""}`,
        "-v",
        `${inputDir}:/input:ro`,
        "-v",
        `${outputDir}:/output`,
        "-e",
        `REPO_URL=${repoUrl}`,
        "-e",
        `REDC_RUN_ID=${runId}`,
        "-e",
        `REDC_JOB_NAME=${request.metadata.jobName}`,
      ];

      if (request.metadata.jobId) {
        args.push("--label", `redc.job_id=${request.metadata.jobId}`);
      }
      if (request.metadata.changeId != null) {
        args.push("--label", `redc.change_id=${request.metadata.changeId}`);
      }
      if (request.metadata.workerId) {
        args.push("--label", `redc.worker_id=${request.metadata.workerId}`);
      }

      if (this.config.openaiApiKey) {
        args.push("-e", `OPENAI_API_KEY=${this.config.openaiApiKey}`);
      } else {
        const opencodeDir = [
          process.env.OPENCODE_DIR,
          "/root/.local/share/opencode",
          process.env.HOST_OPENCODE_DIR,
          join(process.env.HOME ?? "", ".local/share/opencode"),
        ].find((candidate) => candidate && existsSync(candidate));
        if (!opencodeDir) {
          throw new Error("Missing accessible OpenCode auth directory");
        }
        const authPath = join(opencodeDir, "auth.json");
        if (!existsSync(authPath)) {
          throw new Error(`Missing OpenCode auth file at ${authPath}`);
        }
        await writeFile(join(opencodeHomeDir, "auth.json"), await readFile(authPath));
      }
      args.push("-v", `${opencodeHomeDir}:/root/.local/share/opencode`);
      args.push("-e", `OPENCODE_MODEL=${process.env.OPENCODE_MODEL ?? "openai/gpt-5.4"}`);

      const dockerRunNetwork = process.env.DOCKER_RUN_NETWORK;
      if (dockerRunNetwork) {
        args.push("--network", dockerRunNetwork);
      }

      args.push(this.config.image);

      const proc = Bun.spawn(args, {
        stdout: "pipe",
        stderr: "pipe",
      });

      const containerId = await waitForContainerId(cidFile);
      this.config.tracker?.markRunning(runId, containerId ?? null, new Date().toISOString());

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
      }, timeout);

      const stdoutLines: string[] = [];
      const stderrLines: string[] = [];
      const stdoutDone = drainStream(proc.stdout, (line) => {
        const normalized = line.trimEnd();
        if (!normalized.trim()) return;
        stdoutLines.push(normalized);
        request.onLog?.(normalized);
      });
      const stderrDone = drainStream(proc.stderr, (line) => {
        stderrLines.push(line);
      });

      const [, , exitCode] = await Promise.all([stdoutDone, stderrDone, proc.exited]);
      clearTimeout(timer);

      const persistedArtifacts = await persistArtifacts(
        this.config.artifactStore,
        runId,
        inputDir,
        outputDir
      );

      const rollout = await readRolloutMetadata(outputDir);
      if (rollout) {
        this.config.tracker?.attachRollout(
          runId,
          rollout.runtimeSessionId,
          persistedArtifacts?.rolloutPath ?? rollout.rolloutPath
        );
      }

      const logs = [...stdoutLines, ...stderrLines].join("\n");
      const durationMs = Date.now() - start;

      if (timedOut) {
        const error = {
          type: "timeout",
          message: `OpenCode job exceeded timeout of ${timeout}ms`,
        } satisfies ClawRunError;
        this.config.tracker?.finish(runId, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          durationMs,
          errorType: error.type,
          errorMessage: error.message,
        });
        return {
          ok: false,
          runId,
          status: "failed",
          durationMs,
          logs,
          files: [],
          containerName,
          containerId,
          error,
        };
      }

      if (exitCode !== 0) {
        const error = classifyDockerRunFailure(exitCode, stderrLines.length > 0 ? stderrLines : stdoutLines);
        this.config.tracker?.finish(runId, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          durationMs,
          errorType: error.type,
          errorMessage: error.message,
        });
        return {
          ok: false,
          runId,
          status: "failed",
          durationMs,
          logs,
          files: [],
          containerName,
          containerId,
          error,
        };
      }

      let files: ClawOutputFile[];
      try {
        files = await collectFiles(outputDir, request.output.files ?? []);
      } catch (error) {
        const details = asRunError(error, "runtime_error");
        this.config.tracker?.finish(runId, {
          status: "failed",
          finishedAt: new Date().toISOString(),
          durationMs,
          errorType: details.type,
          errorMessage: details.message,
        });
        return {
          ok: false,
          runId,
          status: "failed",
          durationMs,
          logs,
          files: [],
          containerName,
          containerId,
          error: details,
        };
      }

      let parsedJson: TJson | undefined;
      if (request.output.json) {
        const resultPath = join(outputDir, "result.json");
        let raw: unknown;
        try {
          raw = JSON.parse(await readFile(resultPath, "utf8"));
        } catch (error) {
          const details = {
            type: "missing_json",
            message: error instanceof Error ? error.message : String(error),
          } satisfies ClawRunError;
          this.config.tracker?.finish(runId, {
            status: "failed",
            finishedAt: new Date().toISOString(),
            durationMs,
            errorType: details.type,
            errorMessage: details.message,
          });
          return {
            ok: false,
            runId,
            status: "failed",
            durationMs,
            logs,
            files,
            containerName,
            containerId,
            error: details,
          };
        }

        try {
          parsedJson = request.parseJson ? request.parseJson(raw) : (raw as TJson);
        } catch (error) {
          const details = {
            type: "invalid_json",
            message: error instanceof Error ? error.message : String(error),
          } satisfies ClawRunError;
          this.config.tracker?.finish(runId, {
            status: "failed",
            finishedAt: new Date().toISOString(),
            durationMs,
            errorType: details.type,
            errorMessage: details.message,
          });
          return {
            ok: false,
            runId,
            status: "failed",
            durationMs,
            logs,
            files,
            containerName,
            containerId,
            error: details,
          };
        }
      }

      this.config.tracker?.finish(runId, {
        status: "completed",
        finishedAt: new Date().toISOString(),
        durationMs,
      });

      return {
        ok: true,
        runId,
        status: "completed",
        durationMs,
        logs,
        json: parsedJson,
        files,
        containerName,
        containerId,
      };
    } finally {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
}

async function runDockerPreflightChecks(
  image: string,
  writablePath: string
): Promise<ClawRunError | null> {
  const minTmpFreeBytes = getConfiguredMinTmpFreeBytes();
  if (minTmpFreeBytes > 0) {
    const availableBytes = await getAvailableBytes(writablePath);
    if (availableBytes != null && availableBytes < minTmpFreeBytes) {
      return {
        type: "local_environment_failed",
        message: [
          `Insufficient free space for local Docker runner at ${writablePath}.`,
          `${formatBytes(availableBytes)} available; ${formatBytes(minTmpFreeBytes)} required.`,
          "Free disk space or lower CLAW_MIN_TMP_FREE_MB for local development.",
        ].join(" "),
      };
    }
  }

  const dockerInfo = await runCommand(["docker", "info"]);
  if (dockerInfo.exitCode !== 0) {
    return classifyDockerEnvironmentFailure("Docker daemon is unavailable", dockerInfo.stderr || dockerInfo.stdout);
  }

  const imageInspect = await runCommand(["docker", "image", "inspect", image]);
  if (imageInspect.exitCode !== 0) {
    return classifyDockerEnvironmentFailure(
      `Runner image ${image} is unavailable locally`,
      imageInspect.stderr || imageInspect.stdout
    );
  }

  const probeName = `redc-docker-probe-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const createProbe = await runCommand([
    "docker",
    "create",
    "--name",
    probeName,
    "--entrypoint",
    "/bin/sh",
    image,
    "-c",
    "true",
  ]);

  try {
    if (createProbe.exitCode !== 0) {
      return classifyDockerEnvironmentFailure(
        "Docker cannot create runner containers in the current local environment",
        createProbe.stderr || createProbe.stdout
      );
    }
  } finally {
    await runCommand(["docker", "rm", "-f", probeName]);
  }

  return null;
}

async function runCommand(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr, };
}

function classifyDockerRunFailure(exitCode: number, lines: string[]): ClawRunError {
  const detailSuffix = summarizeLogs(lines);
  const combinedLogs = lines.join("\n");
  if (exitCode === 125 && isDockerEnvironmentFailure(combinedLogs)) {
    return classifyDockerEnvironmentFailure(
      "Local Docker environment failed before the runner container could start",
      combinedLogs
    );
  }

  return {
    type: "docker_failed",
    message: detailSuffix
      ? `Container exited with code ${exitCode}. ${detailSuffix}`
      : `Container exited with code ${exitCode}`,
  };
}

function classifyDockerEnvironmentFailure(prefix: string, details: string): ClawRunError {
  const normalized = details.trim();
  const detailSuffix = summarizeLogs(normalized ? normalized.split("\n") : []);
  return {
    type: "local_environment_failed",
    message: detailSuffix ? `${prefix}. ${detailSuffix}` : prefix,
  };
}

function getConfiguredMinTmpFreeBytes(): number {
  const raw = process.env.CLAW_MIN_TMP_FREE_MB ?? process.env.CODEX_MIN_TMP_FREE_MB ?? "4096";
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed * 1024 * 1024;
}

async function getAvailableBytes(path: string): Promise<number | null> {
  const result = await runCommand(["df", "-Pk", path]);
  if (result.exitCode !== 0) return null;
  return parseDfAvailableKilobytes(result.stdout);
}

export function parseDfAvailableKilobytes(output: string): number | null {
  const lines = output.trim().split("\n");
  const dataLine = lines.at(-1);
  if (!dataLine) return null;
  const fields = dataLine.trim().split(/\s+/);
  if (fields.length < 4) return null;
  const availableKilobytes = Number.parseInt(fields[3] ?? "", 10);
  if (!Number.isFinite(availableKilobytes) || availableKilobytes < 0) return null;
  return availableKilobytes * 1024;
}

export function isDockerEnvironmentFailure(details: string): boolean {
  const normalized = details.toLowerCase();
  return [
    "read-only file system",
    "input/output error",
    "overlay2",
    "temporary lease",
    "stale endpoint",
    "failed container removal",
    "error creating temporary lease",
    "failed to remove",
    "failed to create endpoint",
  ].some((pattern) => normalized.includes(pattern));
}

function formatBytes(value: number): string {
  if (value >= 1024 * 1024 * 1024) {
    return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
  }
  return `${Math.round(value / (1024 * 1024))} MiB`;
}

async function drainStream(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let partial = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    partial += decoder.decode(value, { stream: true });
    const lines = partial.split("\n");
    partial = lines.pop() ?? "";
    for (const line of lines) {
      onLine(line);
    }
  }

  if (partial) {
    onLine(partial);
  }
}

async function readRolloutMetadata(outputDir: string): Promise<RolloutMetadata | null> {
  const rolloutPath = join(outputDir, "rollout.json");
  try {
    const raw = JSON.parse(await readFile(rolloutPath, "utf8")) as Partial<RolloutMetadata>;
    return {
      runtimeSessionId: typeof raw.runtimeSessionId === "string" ? raw.runtimeSessionId : null,
      rolloutPath: typeof raw.rolloutPath === "string" ? raw.rolloutPath : null,
    };
  } catch {
    return readOpenCodeEventMetadata(outputDir);
  }
}

async function readOpenCodeEventMetadata(outputDir: string): Promise<RolloutMetadata | null> {
  const eventsPath = join(outputDir, "agent-events.jsonl");
  try {
    return {
      runtimeSessionId: null,
      rolloutPath: eventsPath,
    };
  } catch {
    return null;
  }
}

async function waitForContainerId(cidFile: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < 40; attempt++) {
    try {
      const cid = (await readFile(cidFile, "utf8")).trim();
      if (cid) return cid;
    } catch {}
    await Bun.sleep(50);
  }
  return undefined;
}

function buildContainerName(jobName: string, runId: string): string {
  const safeJobName = jobName.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  const shortRunId = runId.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 12);
  return `redc-${safeJobName || "job"}-${shortRunId || "run"}`;
}

async function collectFiles(outputDir: string, requestedPaths: string[]): Promise<ClawOutputFile[]> {
  const files: ClawOutputFile[] = [];

  for (const relativePath of requestedPaths) {
    const absolutePath = join(outputDir, "files", relativePath);
    try {
      const content = await readFile(absolutePath, "utf8");
      files.push({ path: relativePath, content });
    } catch (error) {
      throw {
        type: "missing_file",
        message: `Missing output file: ${relativePath} (${error instanceof Error ? error.message : String(error)})`,
      };
    }
  }

  return files;
}

function asRunError(
  error: unknown,
  fallbackType: ClawRepoRunResult["error"] extends infer T
    ? T extends { type: infer U }
      ? U
      : never
    : never
) {
  if (
    error &&
    typeof error === "object" &&
    "type" in error &&
    "message" in error &&
    typeof (error as { type: unknown }).type === "string" &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    return error as NonNullable<ClawRepoRunResult["error"]>;
  }

  return {
    type: fallbackType,
    message: error instanceof Error ? error.message : String(error),
  } as NonNullable<ClawRepoRunResult["error"]>;
}

function summarizeLogs(lines: string[], maxLines: number = 12): string {
  const nonEmpty = lines.map((line) => line.trim()).filter(Boolean);
  if (nonEmpty.length === 0) return "";
  return `Last logs: ${nonEmpty.slice(-maxLines).join(" | ")}`;
}

async function persistArtifacts(
  artifactStore: ClawArtifactStore | undefined,
  runId: string,
  inputDir: string,
  outputDir: string
): Promise<PersistedClawArtifacts | null> {
  if (artifactStore) {
    return artifactStore.persistRunArtifacts(runId, inputDir, outputDir);
  }
  return persistRunArtifactsLocally(runId, inputDir, outputDir);
}

async function persistRunArtifactsLocally(
  runId: string,
  inputDir: string,
  outputDir: string
): Promise<PersistedClawArtifacts> {
  const artifactsRoot = process.env.CLAW_ARTIFACTS_DIR ?? process.env.CODEX_ARTIFACTS_DIR ?? ".claw-artifacts";
  const runDir = join(artifactsRoot, runId);
  await rm(runDir, { recursive: true, force: true }).catch(() => {});
  await mkdir(runDir, { recursive: true });
  await cp(inputDir, join(runDir, "input"), { recursive: true });
  await cp(outputDir, join(runDir, "output"), { recursive: true });
  const outputRoot = join(runDir, "output");
  return {
    baseKey: runDir,
    requestKey: join(runDir, "input", "request.json"),
    resultKey: join(outputRoot, "result.json"),
    eventsKey: join(outputRoot, "agent-events.jsonl"),
    filesPrefix: join(outputRoot, "files"),
    rolloutPath: join(outputRoot, "agent-events.jsonl"),
  };
}

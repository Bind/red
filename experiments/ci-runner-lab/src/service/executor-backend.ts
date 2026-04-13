import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type {
  ExecutionBundle,
  ExecutionHandle,
  ExecutionStatus,
  ExecutorBackend,
  FileEntry,
  LogReadResult,
} from "../util/types";

interface InflightExecution {
  process: Bun.Subprocess<"ignore", "pipe", "pipe">;
  stdout: string;
  stderr: string;
  cursor: number;
  status: ExecutionStatus;
  workspaceDir: string;
  artifactsDir: string;
}

function walkFiles(root: string, base = root): FileEntry[] {
  const entries: FileEntry[] = [];

  for (const name of readdirSync(root)) {
    const fullPath = join(root, name);
    const stats = statSync(fullPath, { throwIfNoEntry: false });
    if (!stats) {
      continue;
    }

    if (stats.isDirectory()) {
      entries.push(...walkFiles(fullPath, base));
      continue;
    }

    entries.push({
      path: relative(base, fullPath),
      size: stats.size,
      isSymlink: stats.isSymbolicLink(),
    });
  }

  return entries.sort((left, right) => left.path.localeCompare(right.path));
}

export class InlineShellExecutorBackend implements ExecutorBackend {
  private readonly executions = new Map<string, InflightExecution>();

  async start(bundle: ExecutionBundle): Promise<ExecutionHandle> {
    mkdirSync(bundle.workspaceDir, { recursive: true });
    mkdirSync(bundle.artifactsDir, { recursive: true });

    const process = Bun.spawn({
      cmd: [
        "bash",
        "-lc",
        `mkdir -p "$CI_WORKSPACE_DIR" "$CI_ARTIFACTS_DIR" && exec bash -lc 'echo "[bootstrap] starting"; echo "[job] running ${bundle.jobName}"; ${bundle.env.CI_INLINE_COMMAND ?? "true"}'`,
      ],
      cwd: bundle.workspaceDir,
      env: bundle.env,
      stdout: "pipe",
      stderr: "pipe",
    });

    const executionId = bundle.attemptId;
    const inflight: InflightExecution = {
      process,
      stdout: "",
      stderr: "",
      cursor: 0,
      status: { phase: "starting" },
      workspaceDir: bundle.workspaceDir,
      artifactsDir: bundle.artifactsDir,
    };

    void (async () => {
      inflight.stdout = await new Response(process.stdout).text();
    })();
    void (async () => {
      inflight.stderr = await new Response(process.stderr).text();
    })();
    void process.exited.then((exitCode) => {
      inflight.status =
        exitCode === 0 ? { phase: "succeeded", exitCode } : { phase: "failed", exitCode };
    });

    this.executions.set(executionId, inflight);
    return { backendExecutionId: executionId };
  }

  async status(handle: ExecutionHandle): Promise<ExecutionStatus> {
    const execution = this.executions.get(handle.backendExecutionId);
    if (!execution) {
      return { phase: "failed", exitCode: 1 };
    }

    if (execution.status.phase === "starting") {
      execution.status = { phase: "running" };
    }

    return execution.status;
  }

  async readLogs(handle: ExecutionHandle, cursor: number): Promise<LogReadResult> {
    const execution = this.executions.get(handle.backendExecutionId);
    if (!execution) {
      return { chunks: [], cursor };
    }

    const stdout = execution.stdout.slice(cursor);
    const stderr = execution.stderr.slice(cursor);
    const chunks: LogReadResult["chunks"] = [];

    if (stdout) {
      chunks.push({ stream: "stdout", text: stdout });
    }
    if (stderr) {
      chunks.push({ stream: "stderr", text: stderr });
    }

    const nextCursor = Math.max(execution.stdout.length, execution.stderr.length);
    execution.cursor = nextCursor;
    return {
      chunks,
      cursor: nextCursor,
    };
  }

  async listFiles(handle: ExecutionHandle, containerPath: string): Promise<FileEntry[]> {
    const execution = this.executions.get(handle.backendExecutionId);
    if (!execution) {
      return [];
    }

    if (containerPath !== execution.artifactsDir) {
      return [];
    }

    return walkFiles(containerPath);
  }
}

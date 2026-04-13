import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { hashSegment, parseScript } from "./parser";
import type {
  BashRuntimeConfig,
  ChunkExecution,
  ChunkRecord,
  ExecuteRunRequest,
  RunRecord,
  RunResult,
  RunStatus,
  RunStore,
  ScriptSegment,
} from "../util/types";

const HELPER_SNIPPET = `
durable__kv_dir="$BASH_RUNTIME_STATE_DIR/kv"
mkdir -p "$durable__kv_dir"

durable_set() {
  local key="$1"
  local value="\${2-}"
  if [[ -z "$key" ]]; then
    echo "durable_set requires a key" >&2
    return 64
  fi
  if [[ -z "$value" && ! -t 0 ]]; then
    value="$(cat)"
  fi
  printf '%s' "$value" > "$durable__kv_dir/$key"
}

durable_get() {
  local key="$1"
  if [[ -z "$key" ]]; then
    echo "durable_get requires a key" >&2
    return 64
  fi
  cat "$durable__kv_dir/$key"
}

durable_has() {
  local key="$1"
  [[ -f "$durable__kv_dir/$key" ]]
}
`;

async function readKvDir(path: string): Promise<Record<string, string>> {
  let entries: string[];
  try {
    entries = await readdir(path);
  } catch {
    return {};
  }

  const kv: Record<string, string> = {};
  for (const entry of entries) {
    kv[entry] = await Bun.file(join(path, entry)).text();
  }
  return kv;
}

async function runBlock(
  segment: ScriptSegment,
  workspaceDir: string,
  stateDir: string,
  env: Record<string, string>,
): Promise<{
  exitCode: number;
  stdout: string;
  stderr: string;
}> {
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  const child = Bun.spawn({
    cmd: ["bash", "-lc", `${HELPER_SNIPPET}\n${segment.script}`],
    cwd: workspaceDir,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...env,
      BASH_RUNTIME_WORKSPACE: workspaceDir,
      BASH_RUNTIME_STATE_DIR: stateDir,
    },
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return {
    exitCode,
    stdout,
    stderr,
  };
}

function buildExecution(
  segment: ScriptSegment,
  hash: string,
  cached: boolean,
  chunk: ChunkRecord,
): ChunkExecution {
  return {
    segmentId: segment.id,
    type: segment.type,
    cached,
    status: chunk.status,
    exitCode: chunk.exitCode,
    stdout: chunk.stdout,
    stderr: chunk.stderr,
    hash,
    startedAt: chunk.startedAt,
    completedAt: chunk.completedAt,
    startLine: segment.startLine,
    endLine: segment.endLine,
  };
}

export class BashRuntimeService {
  constructor(
    private readonly config: BashRuntimeConfig,
    private readonly store: RunStore,
  ) {}

  async execute(request: ExecuteRunRequest): Promise<RunResult> {
    const workspaceDir = join(this.config.workspacesDir, request.runId);
    const stateDir = join(workspaceDir, ".durable-state");
    const kvDir = join(stateDir, "kv");
    const run = await this.store.ensureRun(request.runId, request.script, workspaceDir);
    const segments = parseScript(request.script);
    const startedAt = new Date().toISOString();
    const executions: ChunkExecution[] = [];
    let status: RunStatus = "completed";

    for (const segment of segments) {
      const hash = hashSegment(segment.script, request.env);
      if (segment.type === "durable") {
        const cached = run.chunks[segment.id];
        if (cached && cached.hash === hash && cached.status === "completed") {
          executions.push(buildExecution(segment, hash, true, cached));
          if (request.interruptAfterChunk === segment.id) {
            status = "interrupted";
            break;
          }
          continue;
        }
      }

      const runStartedAt = new Date().toISOString();
      const outcome = await runBlock(segment, workspaceDir, stateDir, request.env);
      const runCompletedAt = new Date().toISOString();
      const chunk: ChunkRecord = {
        chunkId: segment.id,
        hash,
        status: outcome.exitCode === 0 ? "completed" : "failed",
        exitCode: outcome.exitCode,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        startedAt: runStartedAt,
        completedAt: runCompletedAt,
      };

      executions.push(buildExecution(segment, hash, false, chunk));
      run.kv = await readKvDir(kvDir);

      if (segment.type === "durable") {
        run.chunks[segment.id] = chunk;
      }

      if (outcome.exitCode !== 0) {
        status = "failed";
        break;
      }

      if (request.interruptAfterChunk === segment.id) {
        status = "interrupted";
        break;
      }
    }

    const result: RunResult = {
      runId: request.runId,
      status,
      executions,
      startedAt,
      completedAt: new Date().toISOString(),
    };

    run.lastResult = result;
    await this.store.saveRun(run);
    return result;
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    return this.store.getRun(runId);
  }
}

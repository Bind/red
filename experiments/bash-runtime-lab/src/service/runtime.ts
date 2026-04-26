import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse, serialize } from "just-bash";
import { instrumentScript } from "./instrumentation";
import type {
  BashRuntimeConfig,
  CommandJournalEvent,
  CommandNodeMetadata,
  ExecuteRunRequest,
  RunRecord,
  RunResult,
  RunStore,
} from "../util/types";

type HookState = {
  journal: CommandJournalEvent[];
  commandNodes: Record<string, CommandNodeMetadata>;
  cache?: Record<string, unknown>;
  dependencyHashes?: Record<string, string>;
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
}

function runtimePaths(config: BashRuntimeConfig, runId: string) {
  const stateDir = join(config.runsDir, `${runId}-runtime`);
  return {
    stateDir,
    stateFile: join(stateDir, "hook-state.json"),
    scriptFile: join(stateDir, "run.sh"),
  };
}

function buildHookPrelude(stateFile: string, workspaceDir: string, hookScript: string): string {
  const bunBin = shellQuote(process.execPath);
  const hookBin = shellQuote(hookScript);
  const quotedState = shellQuote(stateFile);
  const quotedWorkspace = shellQuote(workspaceDir);

  return `
__red_hook() {
  local phase="$1"
  local node_id="$2"
  local cwd="$3"
  local arg6="\${4:-}"
  local arg7="\${5:-}"
  env -0 | ${bunBin} ${hookBin} "$phase" ${quotedState} ${quotedWorkspace} "$node_id" "$cwd" "$arg6" "$arg7"
}

__red_before() {
  eval "$(__red_hook before "$1" "$PWD")"
}

__red_after() {
  local node_id="$1"
  local exit_code="\${2:-$?}"
  local action="\${3:-run}"
  if [ "$action" = "replay" ]; then
    exit_code="\${RED_EXIT:-$exit_code}"
  fi
  __red_hook after "$node_id" "$PWD" "$exit_code" "$action" >/dev/null
  return 0
}
`;
}

async function runScript(
  workspaceDir: string,
  scriptPath: string,
  env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const child = Bun.spawn({
    cmd: ["bash", scriptPath],
    cwd: workspaceDir,
    env: {
      ...process.env,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  return { stdout, stderr, exitCode };
}

export class BashRuntimeService {
  constructor(
    private readonly config: BashRuntimeConfig,
    private readonly store: RunStore,
  ) {}

  async execute(request: ExecuteRunRequest): Promise<RunResult> {
    const workspaceDir = join(this.config.workspacesDir, request.runId);
    const paths = runtimePaths(this.config, request.runId);
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(paths.stateDir, { recursive: true });

    const run = await this.store.ensureRun(
      request.runId,
      request.script,
      workspaceDir,
      request.dependencyHashes ?? {},
    );
    const parsed = parse(request.script);
    const instrumented = instrumentScript(parsed);
    const transformedScript = serialize(instrumented.ast);
    const hookScript = new URL("./hook-cli.ts", import.meta.url).pathname;
    const runScriptSource = `${buildHookPrelude(paths.stateFile, workspaceDir, hookScript)}\n${transformedScript}\n`;

    const priorState = await (async () => {
      const file = Bun.file(paths.stateFile);
      if (!(await file.exists())) {
        return null;
      }
      return (await file.json()) as HookState;
    })();

    await writeJson(paths.stateFile, {
      journal: [],
      commandNodes: instrumented.commandNodes,
      visitCounts: {},
      pending: [],
      cache: priorState?.cache ?? {},
      dependencyHashes: request.dependencyHashes ?? {},
      replayEnabled: true,
    });
    await Bun.write(paths.scriptFile, runScriptSource);

    const startedAt = new Date().toISOString();
    const execution = await runScript(workspaceDir, paths.scriptFile, request.env);
    const completedAt = new Date().toISOString();
    const hookState = JSON.parse(await readFile(paths.stateFile, "utf8")) as HookState;
    const afterEvents = hookState.journal.filter((entry) => entry.phase === "after");
    const replayedAllCommands =
      afterEvents.length > 0 && afterEvents.every((entry) => entry.cached);

    const result: RunResult = {
      runId: request.runId,
      status: execution.exitCode === 0 ? "completed" : "failed",
      stdout:
        replayedAllCommands && !execution.stdout && run.lastResult
          ? run.lastResult.stdout
          : execution.stdout,
      stderr:
        replayedAllCommands && !execution.stderr && run.lastResult
          ? run.lastResult.stderr
          : execution.stderr,
      exitCode: execution.exitCode,
      journal: hookState.journal,
      commandCount: afterEvents.length,
      startedAt,
      completedAt,
    };

    run.commandNodes = hookState.commandNodes;
    run.transformedScript = transformedScript;
    run.journal = hookState.journal;
    run.lastResult = result;
    await this.store.saveRun(run);
    return result;
  }

  async getRun(runId: string): Promise<RunRecord | null> {
    return this.store.getRun(runId);
  }
}

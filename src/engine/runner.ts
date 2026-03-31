import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { homedir } from "node:os";

export interface RepoTaskRequest {
  repo: string;       // "owner/repo"
  baseRef: string;    // base branch to diff against
  headRef: string;    // branch or SHA to checkout
  prompt: string;     // agent instructions
  timeoutMs?: number;
  onLog?: (line: string) => void;
}

export interface RepoTaskResult {
  ok: boolean;
  output: unknown;    // parsed JSON from /output/result.json
  durationMs: number;
  logs: string;       // stderr
}

export interface RepoTaskRunnerConfig {
  image: string;
  forgejoBaseUrl: string;
  /** OpenAI API key. If null, mounts ~/.codex into the container for ChatGPT OAuth auth. */
  openaiApiKey: string | null;
  defaultTimeoutMs?: number;
}

export class RepoTaskRunner {
  constructor(private config: RepoTaskRunnerConfig) {}

  async run(request: RepoTaskRequest): Promise<RepoTaskResult> {
    const timeout = request.timeoutMs ?? this.config.defaultTimeoutMs ?? 120_000;
    const repoUrl = `${this.config.forgejoBaseUrl.replace(/\/+$/, "")}/${request.repo}.git`;
    const tmpDir = await mkdtemp(join(tmpdir(), "redc-runner-"));
    const start = Date.now();

    try {
      const args = [
        "docker", "run", "--rm",
        "-v", `${tmpDir}:/output`,
        "-e", `REPO_URL=${repoUrl}`,
        "-e", `BASE_REF=${request.baseRef}`,
        "-e", `HEAD_REF=${request.headRef}`,
        "-e", `TASK_PROMPT=${request.prompt}`,
      ];

      if (this.config.openaiApiKey) {
        args.push("-e", `OPENAI_API_KEY=${this.config.openaiApiKey}`);
      } else {
        // Mount host codex auth so the container uses ChatGPT OAuth
        const codexDir = join(homedir(), ".codex");
        args.push("-v", `${codexDir}:/root/.codex:ro`);
      }

      args.push(this.config.image);

      const proc = Bun.spawn(args, {
        stdout: "pipe",
        stderr: "pipe",
      });

      const timer = setTimeout(() => proc.kill(), timeout);

      // Stream stderr line-by-line, collecting full output and calling onLog
      const stderrLines: string[] = [];
      const stderrDone = (async () => {
        const reader = proc.stderr.getReader();
        const decoder = new TextDecoder();
        let partial = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          partial += decoder.decode(value, { stream: true });
          const lines = partial.split("\n");
          partial = lines.pop()!; // keep incomplete last line
          for (const line of lines) {
            stderrLines.push(line);
            request.onLog?.(line);
          }
        }
        // Flush remaining partial line
        if (partial) {
          stderrLines.push(partial);
          request.onLog?.(partial);
        }
      })();

      const [, exitCode] = await Promise.all([stderrDone, proc.exited]);
      clearTimeout(timer);

      const stderr = stderrLines.join("\n");
      const durationMs = Date.now() - start;

      if (exitCode !== 0) {
        return { ok: false, output: null, durationMs, logs: stderr.slice(0, 2000) };
      }

      let output: unknown = null;
      try {
        const raw = await readFile(join(tmpDir, "result.json"), "utf-8");
        output = JSON.parse(raw);
      } catch {
        return { ok: false, output: null, durationMs, logs: `No valid result.json. ${stderr.slice(0, 1000)}` };
      }

      return { ok: true, output, durationMs, logs: stderr };
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

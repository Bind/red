import { Codex, type Thread } from "@openai/codex-sdk";
import type { AgentProvider, ProviderSession, ProviderSpawnOptions } from "./types";

export type CodexProviderOptions = {
  model?: string;
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  skipGitRepoCheck?: boolean;
  codexPathOverride?: string;
};

class CodexSession implements ProviderSession {
  private readonly thread: Thread;
  private readonly systemPrompt: string;
  private sentSystem = false;

  constructor(thread: Thread, systemPrompt: string) {
    this.thread = thread;
    this.systemPrompt = systemPrompt;
  }

  async run(input: string) {
    const message = this.sentSystem
      ? input
      : `${this.systemPrompt}\n\n---\n\n${input}`;
    this.sentSystem = true;
    const turn = await this.thread.run(message);
    return {
      finalResponse: turn.finalResponse,
      usage: turn.usage
        ? {
            inputTokens: turn.usage.input_tokens,
            outputTokens: turn.usage.output_tokens,
          }
        : null,
    };
  }

  async stop() {
    // Codex threads are request/response; nothing to tear down.
  }
}

export function createCodexProvider(options: CodexProviderOptions = {}): AgentProvider {
  const codex = new Codex({
    codexPathOverride: options.codexPathOverride,
  });
  return {
    name: "codex",
    async spawn(opts: ProviderSpawnOptions) {
      const thread = codex.startThread({
        model: options.model,
        sandboxMode: options.sandboxMode ?? "workspace-write",
        workingDirectory: opts.cwd,
        skipGitRepoCheck: options.skipGitRepoCheck ?? true,
      });
      return new CodexSession(thread, opts.systemPrompt);
    },
  };
}

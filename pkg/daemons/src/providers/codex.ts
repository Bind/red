import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Codex, type McpToolCallItem, type Thread, type ThreadEvent } from "@openai/codex-sdk";
import { CompletePayload } from "../schema";
import type { AgentProvider, ProviderSession, ProviderSpawnOptions, ProviderTurn } from "./types";

export const MCP_SERVER_NAME = "redc-daemons";
export const COMPLETE_TOOL_NAME = "complete";

export type CodexProviderOptions = {
  model?: string;
  sandboxMode?: "read-only" | "workspace-write" | "danger-full-access";
  skipGitRepoCheck?: boolean;
  codexPathOverride?: string;
  mcpServerCommand?: string;
  mcpServerArgs?: string[];
};

function defaultMcpServerPath(): string {
  const here = fileURLToPath(import.meta.url);
  return resolve(here, "..", "..", "mcp-server", "complete.ts");
}

class CodexSession implements ProviderSession {
  private readonly thread: Thread;
  private readonly systemPrompt: string;
  private sentSystem = false;

  constructor(thread: Thread, systemPrompt: string) {
    this.thread = thread;
    this.systemPrompt = systemPrompt;
  }

  async run(input: string): Promise<ProviderTurn> {
    const message = this.sentSystem
      ? input
      : `${this.systemPrompt}\n\n---\n\n${input}`;
    this.sentSystem = true;

    const { events } = await this.thread.runStreamed(message);

    let complete: CompletePayload | undefined;
    let finalResponse = "";
    let usage: { inputTokens: number; outputTokens: number } | null = null;

    for await (const event of events as AsyncIterable<ThreadEvent>) {
      switch (event.type) {
        case "item.completed":
          if (event.item.type === "mcp_tool_call") {
            const call = event.item as McpToolCallItem;
            if (call.server === MCP_SERVER_NAME && call.tool === COMPLETE_TOOL_NAME) {
              const parsed = CompletePayload.safeParse(call.arguments);
              if (parsed.success) {
                complete = parsed.data;
              }
            }
          }
          if (event.item.type === "agent_message") {
            finalResponse = event.item.text;
          }
          break;
        case "turn.completed":
          usage = {
            inputTokens: event.usage.input_tokens,
            outputTokens: event.usage.output_tokens,
          };
          break;
        case "turn.failed":
          throw new Error(`turn failed: ${event.error.message}`);
        case "error":
          throw new Error(`stream error: ${event.message}`);
        default:
          break;
      }
    }

    return { finalResponse, usage, complete };
  }

  async stop(): Promise<void> {
    // Codex threads don't need explicit teardown; the CLI exits with the thread.
  }
}

export function createCodexProvider(options: CodexProviderOptions = {}): AgentProvider {
  const mcpCommand = options.mcpServerCommand ?? "bun";
  const mcpArgs = options.mcpServerArgs ?? ["run", defaultMcpServerPath()];

  const codex = new Codex({
    codexPathOverride: options.codexPathOverride,
    config: {
      mcp_servers: {
        [MCP_SERVER_NAME]: {
          command: mcpCommand,
          args: mcpArgs,
        },
      },
    },
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

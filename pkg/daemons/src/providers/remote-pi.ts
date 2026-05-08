import { relative, resolve } from "node:path";
import type { AgentProvider, ProviderRunOptions, ProviderRunResult } from "./types";

export type RemotePiProviderOptions = {
  runtime?: "docker" | "podman";
  image: string;
  repoRoot: string;
  command?: string[];
};

type RemoteProviderEnvelope =
  | {
      type: "turn_start";
      turnIndex: number;
    }
  | {
      type: "tool_call";
      turnIndex: number;
      toolName: string;
      args?: unknown;
    }
  | {
      type: "assistant_text_delta";
      turnIndex: number;
      delta: string;
    }
  | {
      type: "turn_end";
      turnIndex: number;
      info: {
        tokens: { input: number; output: number };
        completeCalled: boolean;
      };
    }
  | {
      type: "result";
      result: ProviderRunResult;
    };

export function createRemotePiProvider(options: RemotePiProviderOptions): AgentProvider {
  const runtime = options.runtime ?? "docker";
  const command = options.command ?? ["bun", "/workspace/bureau/container-entry.ts"];
  const repoRoot = resolve(options.repoRoot);

  return {
    name: "remote-pi",
    async runUntilComplete(input: ProviderRunOptions): Promise<ProviderRunResult> {
      const workspaceCwd = toWorkspacePath(repoRoot, input.cwd);
      const args = [runtime, "run", "--rm", "-i"];
      if (runtime === "docker") {
        args.push("--add-host", "host.docker.internal:host-gateway");
      }
      args.push("-v", `${repoRoot}:/workspace`);
      args.push("-w", "/workspace", options.image, ...command);

      const proc = Bun.spawn({
        cmd: args,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
      proc.stdin.write(
        JSON.stringify({
          ...input,
          cwd: workspaceCwd,
        }),
      );
      proc.stdin.end();

      let result: ProviderRunResult | null = null;
      const stdoutDone = consumeJsonl(proc.stdout, (event) => {
        switch (event.type) {
          case "turn_start":
            input.onTurnStart?.(event.turnIndex);
            break;
          case "tool_call":
            input.onToolCall?.(event.turnIndex, event.toolName, event.args);
            break;
          case "assistant_text_delta":
            input.onAssistantTextDelta?.(event.turnIndex, event.delta);
            break;
          case "turn_end":
            input.onTurnEnd?.(event.turnIndex, event.info);
            break;
          case "result":
            result = event.result;
            break;
        }
      });

      const [stderr, exitCode] = await Promise.all([
        new Response(proc.stderr).text(),
        proc.exited,
        stdoutDone,
      ]);

      if (exitCode !== 0) {
        throw new Error(`remote provider command failed (${args.join(" ")}): ${stderr.trim()}`);
      }
      if (!result) {
        throw new Error("remote provider command completed without a result event");
      }
      return result;
    },
  };
}

function toWorkspacePath(repoRoot: string, cwd: string): string {
  const absoluteCwd = resolve(cwd);
  const relativeCwd = relative(repoRoot, absoluteCwd);
  if (relativeCwd.startsWith("..")) {
    throw new Error(`remote provider cwd must stay inside repoRoot: ${absoluteCwd}`);
  }
  return relativeCwd.length === 0 ? "/workspace" : `/workspace/${relativeCwd}`;
}

async function consumeJsonl(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: RemoteProviderEnvelope) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    buffer = flushBuffer(buffer, onEvent);
  }
  buffer += decoder.decode();
  flushBuffer(buffer, onEvent);
}

function flushBuffer(buffer: string, onEvent: (event: RemoteProviderEnvelope) => void): string {
  const lines = buffer.split("\n");
  const trailing = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    onEvent(JSON.parse(trimmed) as RemoteProviderEnvelope);
  }
  return trailing;
}

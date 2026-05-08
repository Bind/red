import { resolve } from "node:path";
import type {
  AgentProvider,
  ProviderRunCallbacks,
  ProviderRunResult,
} from "../pkg/daemons/src/providers/types";
import type { BureauStoredSession } from "./session-store";

export type BureauRemoteRunInput = ProviderRunCallbacks & {
  root: string;
  agentName: string;
  args: unknown;
  userInput: string | null;
  maxTurns: number;
  maxWallclockMs: number;
};

export type BureauRemoteResumeInput = BureauRemoteRunInput & {
  parentSession: BureauStoredSession;
};

export interface RemoteBureauAgentProvider extends AgentProvider {
  runBureauAgent(input: BureauRemoteRunInput): Promise<ProviderRunResult>;
  resumeBureauAgent(input: BureauRemoteResumeInput): Promise<ProviderRunResult>;
}

export function isRemoteBureauAgentProvider(
  provider: AgentProvider,
): provider is RemoteBureauAgentProvider {
  return typeof (provider as Partial<RemoteBureauAgentProvider>).runBureauAgent === "function"
    && typeof (provider as Partial<RemoteBureauAgentProvider>).resumeBureauAgent === "function";
}

export type RemoteBureauProviderOptions = {
  runtime?: "docker" | "podman";
  image: string;
  repoRoot: string;
  command?: string[];
  providerMode?: "fixture";
};

type RemoteBureauEnvelope =
  | { type: "result"; result: ProviderRunResult };

export function createRemoteBureauProvider(
  options: RemoteBureauProviderOptions,
): RemoteBureauAgentProvider {
  const runtime = options.runtime ?? "docker";
  const command = options.command ?? ["bun", "/runner/bureau/container-entry.ts"];
  const repoRoot = resolve(options.repoRoot);

  return {
    name: "remote-bureau",
    async runUntilComplete() {
      throw new Error("remote-bureau provider only supports bureau.run({ agent, ... })");
    },
    async runBureauAgent(input) {
      return await runRemoteBureauCommand({
        runtime,
        image: options.image,
        command,
        repoRoot,
        request: {
          mode: "run-agent",
          root: "/workspace",
          agentName: input.agentName,
          args: input.args,
          userInput: input.userInput,
          maxTurns: input.maxTurns,
          maxWallclockMs: input.maxWallclockMs,
          providerMode: options.providerMode ?? "fixture",
        },
        mountRoot: input.root,
      });
    },
    async resumeBureauAgent(input) {
      return await runRemoteBureauCommand({
        runtime,
        image: options.image,
        command,
        repoRoot,
        request: {
          mode: "resume-agent",
          root: "/workspace",
          agentName: input.agentName,
          args: input.args,
          userInput: input.userInput,
          maxTurns: input.maxTurns,
          maxWallclockMs: input.maxWallclockMs,
          providerMode: options.providerMode ?? "fixture",
          parentSession: input.parentSession,
        },
        mountRoot: input.root,
      });
    },
  };
}

async function runRemoteBureauCommand(input: {
  runtime: "docker" | "podman";
  image: string;
  command: string[];
  repoRoot: string;
  request: Record<string, unknown>;
  mountRoot: string;
}): Promise<ProviderRunResult> {
  const mountRoot = resolve(input.mountRoot);
  const repoRoot = resolve(input.repoRoot);
  const args = [input.runtime, "run", "--rm", "-i"];
  if (input.runtime === "docker") {
    args.push("--add-host", "host.docker.internal:host-gateway");
  }
  args.push(
    "-v",
    `${repoRoot}:/runner`,
    "-v",
    `${mountRoot}:/workspace`,
    "-w",
    "/workspace",
    input.image,
    ...input.command,
  );

  const proc = Bun.spawn({
    cmd: args,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(JSON.stringify(input.request));
  proc.stdin.end();

  let result: ProviderRunResult | null = null;
  const stdoutDone = consumeJsonl(proc.stdout, (event) => {
    if (event.type === "result") {
      result = event.result;
    }
  });

  const [stderr, exitCode] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
    stdoutDone,
  ]);

  if (exitCode !== 0) {
    throw new Error(`remote bureau command failed (${args.join(" ")}): ${stderr.trim()}`);
  }
  if (!result) {
    throw new Error("remote bureau command completed without a result event");
  }
  return result;
}

async function consumeJsonl(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: RemoteBureauEnvelope) => void,
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

function flushBuffer(
  buffer: string,
  onEvent: (event: RemoteBureauEnvelope) => void,
): string {
  const lines = buffer.split("\n");
  const trailing = lines.pop() ?? "";
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    onEvent(JSON.parse(trimmed) as RemoteBureauEnvelope);
  }
  return trailing;
}

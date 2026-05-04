import type { AgentProvider } from "../pkg/daemons/src/providers/types";
import { createPiProvider, createFileCodexAuthSource } from "../pkg/daemons/src/index";
import { resolveBureauAgent, type ResolvedBureauAgent } from "./resolve-agent";
import { createLocalBureauSessionStore, type BureauStoredSession } from "./session-store";
import { resumeBureauAgent, runBureauAgent } from "./runtime";

export async function runBureauCli(
  argv: string[],
  deps: {
    cwd?: string;
    provider?: AgentProvider;
    resolveAgent?: typeof resolveBureauAgent;
    prompt?: () => Promise<string | null>;
    stdout?: (line: string) => void;
    stdoutText?: (chunk: string) => void;
    stderr?: (line: string) => void;
  } = {},
): Promise<number> {
  const stderr = deps.stderr ?? ((line: string) => console.error(line));
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  const stdoutText = deps.stdoutText ?? ((chunk: string) => process.stdout.write(chunk));
  const cwd = deps.cwd ?? process.cwd();
  const parsed = parseRunArgs(argv);

  const provider =
    deps.provider ??
    createPiProvider({
      authSource: createFileCodexAuthSource(),
    });
  const userInput = parsed.input ?? (deps.prompt ? await deps.prompt() : null);
  const resolver = deps.resolveAgent ?? resolveBureauAgent;

  if (parsed.command === "run" && parsed.agentName) {
    const resolved = await resolver({
      agentName: parsed.agentName,
      args: parsed.args,
      root: cwd,
    });

    await runResolvedAgent({
      resolved,
      provider,
      userInput,
      stdout,
      stdoutText,
    });

    return 0;
  }

  if (parsed.command === "resume" && parsed.sessionId) {
    const store = createLocalBureauSessionStore({ rootDir: cwd });
    const parentSession = await store.get(parsed.sessionId);
    if (!parentSession) {
      stderr(`Unknown session: ${parsed.sessionId}`);
      return 1;
    }
    const resolved = await resolver({
      agentName: parentSession.meta.agentName,
      args: parentSession.meta.args,
      root: cwd,
    });

    await resumeResolvedAgent({
      resolved,
      parentSession,
      provider,
      userInput,
      stdout,
      stdoutText,
    });

    return 0;
  }

  stderr("Usage: bureau run <agent> [--args <json>] [--input <text>]");
  stderr("   or: bureau resume <session-id> [--input <text>]");
  return 1;
}

type RunArgs = {
  command: string | null;
  agentName: string | null;
  sessionId: string | null;
  args: unknown;
  input: string | null;
};

function parseRunArgs(argv: string[]): RunArgs {
  const [command = null, target = null, ...rest] = argv;
  let args: unknown = null;
  let input: string | null = null;

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (token === "--args" && rest[index + 1]) {
      args = JSON.parse(rest[++index]!);
      continue;
    }
    if (token === "--input" && rest[index + 1]) {
      input = rest[++index]!;
    }
  }

  return {
    command,
    agentName: command === "run" ? target : null,
    sessionId: command === "resume" ? target : null,
    args,
    input,
  };
}

async function runResolvedAgent<Input>(input: {
  resolved: ResolvedBureauAgent<Input>;
  provider: AgentProvider;
  userInput: string | null;
  stdout: (line: string) => void;
  stdoutText: (chunk: string) => void;
}) {
  const output = createCliOutput(input.stdout, input.stdoutText);
  const outcome = await runBureauAgent({
    definition: input.resolved.definition,
    context: input.resolved.context,
    input: input.resolved.buildInput(input.userInput),
    args: input.resolved.args,
    provider: input.provider,
    maxTurns: 4,
    maxWallclockMs: 120_000,
    mode: "run",
    providerCallbacks: {
      onTurnStart(turnIndex) {
        output.line(`turn.started ${turnIndex}`);
      },
      onToolCall(turnIndex, toolName, args) {
        output.line(`tool.called ${turnIndex} ${toolName} ${JSON.stringify(args ?? null)}`);
      },
      onAssistantTextDelta(_turnIndex, delta) {
        output.text(delta);
      },
      onTurnEnd(turnIndex, info) {
        output.line(
          `turn.completed ${turnIndex} input=${info.tokens.input} output=${info.tokens.output} complete=${info.completeCalled}`,
        );
      },
    },
  });

  if (output.finish()) {
    const assistantReply = extractLastAssistantText(outcome.session.snapshot.messages);
    if (assistantReply) {
      output.line(assistantReply);
    }
  }

  return outcome;
}

async function resumeResolvedAgent<Input>(input: {
  resolved: ResolvedBureauAgent<Input>;
  parentSession: BureauStoredSession;
  provider: AgentProvider;
  userInput: string | null;
  stdout: (line: string) => void;
  stdoutText: (chunk: string) => void;
}) {
  const output = createCliOutput(input.stdout, input.stdoutText);
  const outcome = await resumeBureauAgent({
    definition: input.resolved.definition,
    context: input.resolved.context,
    input: input.resolved.buildInput(input.userInput),
    parentSession: input.parentSession,
    provider: input.provider,
    maxTurns: 4,
    maxWallclockMs: 120_000,
    mode: "resume",
    providerCallbacks: {
      onTurnStart(turnIndex) {
        output.line(`turn.started ${turnIndex}`);
      },
      onToolCall(turnIndex, toolName, args) {
        output.line(`tool.called ${turnIndex} ${toolName} ${JSON.stringify(args ?? null)}`);
      },
      onAssistantTextDelta(_turnIndex, delta) {
        output.text(delta);
      },
      onTurnEnd(turnIndex, info) {
        output.line(
          `turn.completed ${turnIndex} input=${info.tokens.input} output=${info.tokens.output} complete=${info.completeCalled}`,
        );
      },
    },
  });

  if (output.finish()) {
    const assistantReply = extractLastAssistantText(outcome.session.snapshot.messages);
    if (assistantReply) {
      output.line(assistantReply);
    }
  }

  return outcome;
}

function createCliOutput(
  stdout: (line: string) => void,
  stdoutText: (chunk: string) => void,
) {
  let hasInlineText = false;
  let renderedInlineText = false;

  return {
    line(line: string) {
      if (hasInlineText) {
        stdoutText("\n");
        hasInlineText = false;
      }
      stdout(line);
    },
    text(chunk: string) {
      if (!chunk) return;
      hasInlineText = true;
      renderedInlineText = true;
      stdoutText(chunk);
    },
    finish() {
      if (hasInlineText) {
        stdoutText("\n");
        hasInlineText = false;
      }
      return !renderedInlineText;
    },
  };
}

function extractLastAssistantText(messages: unknown[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = extractAssistantText(messages[index]);
    if (text) return text;
  }

  return null;
}

function extractAssistantText(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const candidate = message as { role?: unknown; content?: unknown };
  if (candidate.role !== "assistant") return null;

  if (typeof candidate.content === "string") {
    const text = candidate.content.trim();
    return text || null;
  }

  if (Array.isArray(candidate.content)) {
    const text = candidate.content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const candidatePart = part as { text?: unknown };
        return typeof candidatePart.text === "string" ? candidatePart.text : "";
      })
      .join("")
      .trim();
    return text || null;
  }

  return null;
}

import type { AgentProvider } from "../pkg/daemons/src/providers/types";
import { createPiProvider, createFileCodexAuthSource } from "../pkg/daemons/src/index";
import { resolveBureauAgent, type ResolvedBureauAgent } from "./resolve-agent";
import { runBureauAgent } from "./runtime";

export async function runBureauCli(
  argv: string[],
  deps: {
    cwd?: string;
    provider?: AgentProvider;
    resolveAgent?: typeof resolveBureauAgent;
    prompt?: () => Promise<string | null>;
    stdout?: (line: string) => void;
    stderr?: (line: string) => void;
  } = {},
): Promise<number> {
  const stderr = deps.stderr ?? ((line: string) => console.error(line));
  const stdout = deps.stdout ?? ((line: string) => console.log(line));
  const cwd = deps.cwd ?? process.cwd();
  const parsed = parseRunArgs(argv);

  if (parsed.command !== "run" || !parsed.agentName) {
    stderr("Usage: bureau run <agent> [--args <json>] [--input <text>]");
    return 1;
  }

  const resolver = deps.resolveAgent ?? resolveBureauAgent;
  const userInput =
    parsed.input ??
    (deps.prompt ? await deps.prompt() : null);
  const resolved = await resolver({
    agentName: parsed.agentName,
    args: parsed.args,
    root: cwd,
  });

  await runResolvedAgent({
    resolved,
    provider:
      deps.provider ??
      createPiProvider({
        authSource: createFileCodexAuthSource(),
      }),
    userInput,
    stdout,
  });

  return 0;
}

type RunArgs = {
  command: string | null;
  agentName: string | null;
  args: unknown;
  input: string | null;
};

function parseRunArgs(argv: string[]): RunArgs {
  const [command = null, agentName = null, ...rest] = argv;
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

  return { command, agentName, args, input };
}

async function runResolvedAgent<Input>(input: {
  resolved: ResolvedBureauAgent<Input>;
  provider: AgentProvider;
  userInput: string | null;
  stdout: (line: string) => void;
}) {
  return runBureauAgent({
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
        input.stdout(`turn.started ${turnIndex}`);
      },
      onToolCall(turnIndex, toolName, args) {
        input.stdout(`tool.called ${turnIndex} ${toolName} ${JSON.stringify(args ?? null)}`);
      },
      onTurnEnd(turnIndex, info) {
        input.stdout(
          `turn.completed ${turnIndex} input=${info.tokens.input} output=${info.tokens.output} complete=${info.completeCalled}`,
        );
      },
    },
  });
}

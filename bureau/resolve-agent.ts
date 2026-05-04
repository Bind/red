import {
  buildLibrarianContext,
  createLibrarianDefinition,
  type LibrarianInput,
} from "./agents/librarian/agent";
import { agent, type BureauAgentContext, type BureauAgentDefinition } from "./sdk";

export type ResolvedBureauAgent<Input = unknown> = {
  agentName: string;
  args: Input;
  definition: BureauAgentDefinition<Input>;
  context: Omit<BureauAgentContext<Input>, "sessionId" | "input">;
  buildInput(userInput: string | null): Input;
};

export async function resolveBureauAgent(input: {
  agentName: string;
  args: unknown;
  root: string;
}): Promise<ResolvedBureauAgent> {
  if (input.agentName === "librarian") {
    return {
      agentName: "librarian",
      args: input.args as LibrarianInput,
      definition: createLibrarianDefinition(),
      context: buildLibrarianContext(input.root),
      buildInput() {
        return input.args as LibrarianInput;
      },
    };
  }

  if (input.agentName === "daemon-executor") {
    return {
      agentName: "daemon-executor",
      args: input.args,
      definition: createDaemonExecutorDefinition(),
      context: buildDaemonExecutorContext(input.root),
      buildInput(userInput) {
        return {
          args: input.args,
          userInput,
        };
      },
    };
  }

  throw new Error(`unknown bureau agent: ${input.agentName}`);
}

function createDaemonExecutorDefinition() {
  return agent<{ args: unknown; userInput: string | null }>()
    .instructions(
      [
        "You are the bureau daemon executor.",
        "Run as the selected repo daemon using the provided JSON arguments.",
        "Stay within the daemon's declared scope and use the available runtime tools.",
      ].join(" "),
    )
    .initialInput((ctx) => {
      const payload = JSON.stringify(ctx.input.args, null, 2);
      if (!ctx.input.userInput) return payload;
      return `${payload}\n\nUser request:\n${ctx.input.userInput}`;
    })
    .build();
}

function buildDaemonExecutorContext(
  root: string,
): Omit<BureauAgentContext<unknown>, "sessionId" | "input"> {
  return {
    name: "daemon-executor",
    sourceRoot: root,
    root,
    cwd: root,
    agentDir: `${root}/bureau/agents/daemon-executor`,
    assets: { skills: [] },
    emit() {},
    resolveAsset(relativePath: string) {
      return `${root}/bureau/agents/daemon-executor/${relativePath}`;
    },
    resolveSharedAsset(relativePath: string) {
      return `${root}/bureau/shared/${relativePath}`;
    },
  };
}

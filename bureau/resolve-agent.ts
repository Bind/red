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
    };
  }

  if (input.agentName === "daemon-executor") {
    return {
      agentName: "daemon-executor",
      args: input.args,
      definition: createDaemonExecutorDefinition(),
      context: buildDaemonExecutorContext(input.root),
    };
  }

  throw new Error(`unknown bureau agent: ${input.agentName}`);
}

function createDaemonExecutorDefinition() {
  return agent<unknown>()
    .instructions(
      [
        "You are the bureau daemon executor.",
        "Run as the selected repo daemon using the provided JSON arguments.",
        "Stay within the daemon's declared scope and use the available runtime tools.",
      ].join(" "),
    )
    .initialInput((ctx) => JSON.stringify(ctx.input, null, 2))
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

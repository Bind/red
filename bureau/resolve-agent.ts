import {
  buildLibrarianContext,
  createLibrarianAgentInstance,
  createLibrarianDefinition,
  type LibrarianInput,
} from "./agents/librarian/agent";
import {
  createDaemonExecutorAgentInstance,
  type DaemonExecutorArgs,
} from "./agents/daemon-executor/agent";
import {
  createTriageAnalyzeAgentInstance,
  type WideRollupRecord,
} from "./agents/triage-analyze/agent";
import {
  createTriageProposeAgentInstance,
  type TriageProposeInput,
} from "./agents/triage-propose/agent";
import type { BureauAgentInstance } from "./sdk";

export type ResolvedBureauAgent<Input = unknown> = BureauAgentInstance<Input>;

export async function resolveBureauAgent(input: {
  agentName: string;
  args: unknown;
  root: string;
}): Promise<ResolvedBureauAgent> {
  if (input.agentName === "librarian") {
    if (input.args != null) {
      return createLibrarianAgentInstance(input.args as LibrarianInput, input.root);
    }
    return {
      name: "librarian",
      args: input.args as LibrarianInput,
      definition: createLibrarianDefinition(),
      context: buildLibrarianContext(input.root),
      buildInput(userInput) {
        return { file: userInput ?? "" };
      },
    };
  }

  if (input.agentName === "daemon-executor") {
    return createDaemonExecutorAgentInstance(input.args as DaemonExecutorArgs, input.root);
  }

  if (input.agentName === "triage-analyze") {
    const args = input.args as { rollup: WideRollupRecord };
    return createTriageAnalyzeAgentInstance(args.rollup, input.root);
  }

  if (input.agentName === "triage-propose") {
    return createTriageProposeAgentInstance(input.args as TriageProposeInput, input.root);
  }

  throw new Error(`unknown bureau agent: ${input.agentName}`);
}

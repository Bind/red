import { relative, resolve } from "node:path";
import {
  buildLibrarianContext,
  createLibrarianDefinition,
  type LibrarianInput,
} from "./agents/librarian/agent";
import {
  buildDaemonReviewInput,
  buildSystemPrompt,
} from "./agents/daemon-executor/agent";
import { agent, type BureauAgentContext, type BureauAgentDefinition } from "./sdk";
import {
  buildMemoryPrompt,
  createDaemonMemoryStore,
  createTrackTool,
  loadMemorySnapshot,
  resolveDaemon,
} from "../pkg/daemons/src/index";

export type DaemonExecutorArgs = {
  daemonName: string;
  reviewRoot?: string;
  relevantFiles?: string[];
};

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
      buildInput(userInput) {
        if (input.args != null) return input.args as LibrarianInput;
        return { file: userInput ?? "" };
      },
    };
  }

  if (input.agentName === "daemon-executor") {
    const args = input.args as DaemonExecutorArgs;
    return {
      agentName: "daemon-executor",
      args,
      definition: createDaemonExecutorDefinition(),
      context: buildDaemonExecutorContext(input.root),
      buildInput(userInput) {
        return { args, userInput };
      },
    };
  }

  throw new Error(`unknown bureau agent: ${input.agentName}`);
}

function createDaemonExecutorDefinition() {
  return agent<{ args: DaemonExecutorArgs; userInput: string | null }>()
    .plan(async (ctx) => {
      const { daemonName, reviewRoot = ctx.root, relevantFiles = [] } = ctx.input.args;
      const spec = await resolveDaemon(daemonName, ctx.sourceRoot);
      const relScopeRoot = relative(ctx.sourceRoot, spec.scopeRoot);
      const scopeRoot = resolve(reviewRoot, relScopeRoot);
      const snapshot = await loadMemorySnapshot(spec.name, scopeRoot);
      const memoryStore = await createDaemonMemoryStore(spec.name, scopeRoot);
      const runId = `run_${spec.name}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const trackTool = createTrackTool(memoryStore, runId);
      const systemPrompt = buildSystemPrompt(spec, buildMemoryPrompt(snapshot));
      const reviewInput = await buildDaemonReviewInput(relevantFiles, snapshot);
      return {
        systemPrompt,
        initialInput: ctx.input.userInput
          ? `${reviewInput}\n\nUser request:\n${ctx.input.userInput}`
          : reviewInput,
        tools: [trackTool],
        cwd: scopeRoot,
      };
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

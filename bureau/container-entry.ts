import type { ProviderRunOptions, ProviderRunResult } from "../pkg/daemons/src/providers/types";
import { agent, type BureauAgentContext, type BureauAgentDefinition } from "./sdk";
import { resolveBureauAgent } from "./resolve-agent";
import type { BureauStoredSession } from "./session-store";

type FixtureCaptureToolsRequest = {
  mode: "fixture.capture-tools";
  root: string;
  agentName: string;
  args: unknown;
  userInput: string | null;
  maxTurns: number;
  maxWallclockMs: number;
};

type FixtureRunAgentRequest = {
  mode: "run-agent";
  root: string;
  agentName: string;
  args: unknown;
  userInput: string | null;
  maxTurns: number;
  maxWallclockMs: number;
  providerMode: "fixture";
};

type FixtureResumeAgentRequest = {
  mode: "resume-agent";
  root: string;
  agentName: string;
  args: unknown;
  userInput: string | null;
  parentSession: BureauStoredSession;
  maxTurns: number;
  maxWallclockMs: number;
  providerMode: "fixture";
};

type ContainerEntryRequest =
  | FixtureCaptureToolsRequest
  | FixtureRunAgentRequest
  | FixtureResumeAgentRequest;

const request = JSON.parse(await new Response(process.stdin).text()) as ContainerEntryRequest;

if (request.mode === "fixture.capture-tools") {
  const resolved = await resolveContainerAgent(request);
  const input = resolved.buildInput(request.userInput);
  const plan = await resolved.definition.run({
    ...resolved.context,
    sessionId: "ses_container",
    input,
  });

  const result = await createFixtureCaptureToolsProvider().runUntilComplete({
    cwd: plan.cwd ?? resolved.context.cwd,
    systemPrompt: plan.systemPrompt,
    initialInput: plan.initialInput,
    maxTurns: request.maxTurns,
    maxWallclockMs: request.maxWallclockMs,
    extraTools: plan.tools ?? [],
  });

  process.stdout.write(`${JSON.stringify({ type: "result", result })}\n`);
} else if (request.mode === "run-agent") {
  const resolved = await resolveContainerAgent(request);
  const input = resolved.buildInput(request.userInput);
  const plan = await resolved.definition.run({
    ...resolved.context,
    sessionId: "ses_container",
    input,
  });

  const result = await createFixtureAgentProvider(resolved.name).runUntilComplete({
    cwd: plan.cwd ?? resolved.context.cwd,
    systemPrompt: plan.systemPrompt,
    initialInput: plan.initialInput,
    maxTurns: request.maxTurns,
    maxWallclockMs: request.maxWallclockMs,
    extraTools: plan.tools ?? [],
  });

  process.stdout.write(`${JSON.stringify({ type: "result", result })}\n`);
} else if (request.mode === "resume-agent") {
  const resolved = await resolveContainerAgent(request);
  const input = resolved.buildInput(request.userInput);
  const plan = await resolved.definition.run({
    ...resolved.context,
    sessionId: "ses_container",
    input,
  });

  const result = await createFixtureAgentProvider(resolved.name).runUntilComplete({
    cwd: plan.cwd ?? resolved.context.cwd,
    systemPrompt: request.parentSession.snapshot.systemPrompt,
    initialInput: plan.initialInput,
    messages: request.parentSession.snapshot.messages,
    maxTurns: request.maxTurns,
    maxWallclockMs: request.maxWallclockMs,
    extraTools: plan.tools ?? [],
  });

  process.stdout.write(`${JSON.stringify({ type: "result", result })}\n`);
} else {
  throw new Error(`Unsupported bureau container entry mode: ${(request as { mode?: string }).mode}`);
}

function createFixtureAgentProvider(agentName: string) {
  return {
    name: "fixture-run-agent",
    async runUntilComplete(opts: ProviderRunOptions): Promise<ProviderRunResult> {
      return {
        ok: true,
        payload: {
          summary: `ran ${agentName} inside container`,
          findings: [],
        } as ProviderRunResult & unknown as never,
        turns: 1,
        tokens: { input: 1, output: 1 },
        session: {
          systemPrompt: opts.systemPrompt,
          messages: [
            ...(opts.messages ?? []),
            { role: "user", content: opts.initialInput },
            { role: "assistant", content: `ran ${agentName} inside container` },
          ],
        },
      };
    },
  };
}

function createFixtureCaptureToolsProvider() {
  return {
    name: "fixture-capture-tools",
    async runUntilComplete(opts: ProviderRunOptions): Promise<ProviderRunResult> {
      return {
        ok: true,
        payload: {
          summary: "captured in-container tools",
          findings: [],
          toolNames: (opts.extraTools ?? []).map((tool) => tool.name).sort(),
          cwd: opts.cwd,
        } as ProviderRunResult & unknown as never,
        turns: 1,
        tokens: { input: 1, output: 1 },
        session: {
          systemPrompt: opts.systemPrompt,
          messages: [
            { role: "user", content: opts.initialInput },
            { role: "assistant", content: "captured in-container tools" },
          ],
        },
      };
    },
  };
}

async function resolveContainerAgent(request: {
  root: string;
  agentName: string;
  args: unknown;
}) {
  return request.agentName === "__fixture_local_tool__"
    ? createFixtureLocalToolAgent(request.root)
    : await resolveBureauAgent({
        agentName: request.agentName,
        args: request.args,
        root: request.root,
      });
}

function createFixtureLocalToolAgent(root: string): {
  args: null;
  definition: BureauAgentDefinition<null>;
  context: Omit<BureauAgentContext<null>, "sessionId" | "input">;
  buildInput(userInput: string | null): null;
} {
  return {
    args: null,
    definition: agent<null>()
      .plan((ctx) => ({
        systemPrompt: "fixture local tool agent",
        initialInput: ctx.input === null ? "fixture input" : "fixture input",
        tools: [
          {
            name: "fixture-local-tool",
            description: "fixture local tool",
            parameters: { type: "object", properties: {} },
            execute: async () => ({}),
          },
        ],
        cwd: root,
      }))
      .build(),
    context: {
      name: "fixture-local-tool-agent",
      sourceRoot: root,
      sessionRoot: root,
      root,
      cwd: root,
      agentDir: `${root}/bureau/agents/fixture-local-tool-agent`,
      assets: { skills: [] },
      emit() {},
      resolveAsset(relativePath: string) {
        return `${root}/bureau/agents/fixture-local-tool-agent/${relativePath}`;
      },
      resolveSharedAsset(relativePath: string) {
        return `${root}/bureau/shared/${relativePath}`;
      },
    },
    buildInput() {
      return null;
    },
  };
}

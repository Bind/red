import { expect, test } from "bun:test";
import { startWorkflowObserver } from "./observability";
import { runAgent, type ProviderRunner } from "./agent-runtime";

test("runAgent emits start/turn/tool/completed and aggregates tokens", async () => {
  const observer = startWorkflowObserver({
    workflowName: "test-workflow",
    runId: "run_workflow_1",
    sinks: [],
  });
  const providerCall: ProviderRunner<{ ok: true }> = async (hooks) => {
    hooks.onTurnStart(1);
    hooks.onToolCall(1, "read", { path: "x.ts" });
    hooks.onTurnEnd(1, { tokens: { input: 100, output: 50 }, completeCalled: false });
    hooks.onTurnStart(2);
    hooks.onTurnEnd(2, { tokens: { input: 30, output: 20 }, completeCalled: true });
    return { ok: true };
  };

  const { result, events, turns, tokens } = await runAgent(
    { agentName: "test-agent", observer, agentRunId: "agent_test_1" },
    providerCall,
  );

  expect(result).toEqual({ ok: true });
  expect(turns).toBe(2);
  expect(tokens).toEqual({ input: 130, output: 70 });
  expect(events.map((e) => e.kind)).toEqual([
    "agent.run.started",
    "agent.turn.started",
    "agent.tool.called",
    "agent.turn.completed",
    "agent.turn.started",
    "agent.turn.completed",
    "agent.run.completed",
  ]);
});

test("each agent event carries workflowRunId, agentRunId, and agentName", async () => {
  const observer = startWorkflowObserver({
    workflowName: "test-workflow",
    runId: "run_workflow_2",
    sinks: [],
  });
  const providerCall: ProviderRunner<{ ok: true }> = async () => ({ ok: true });

  const { events } = await runAgent(
    { agentName: "my-agent", observer, agentRunId: "agent_2" },
    providerCall,
  );

  for (const event of events) {
    expect(event.data).toMatchObject({
      agentName: "my-agent",
      agentRunId: "agent_2",
      workflowRunId: "run_workflow_2",
      workflowName: "test-workflow",
    });
    expect(event.route_name).toBe("my-agent");
  }
});

test("toolCallExtractor decorates agent.tool.called events", async () => {
  const providerCall: ProviderRunner<{ ok: true }> = async (hooks) => {
    hooks.onToolCall(1, "read", { path: "/scope/foo.ts" });
    hooks.onToolCall(1, "search", { query: "x" });
    return { ok: true };
  };

  const { events } = await runAgent(
    {
      agentName: "test-agent",
      toolCallExtractor: (_turn, toolName, args) => {
        if (toolName !== "read") return null;
        return { checkedPath: (args as { path: string }).path };
      },
    },
    providerCall,
  );

  const toolEvents = events.filter((e) => e.kind === "agent.tool.called");
  expect(toolEvents).toHaveLength(2);
  expect(toolEvents[0].data).toMatchObject({ toolName: "read", checkedPath: "/scope/foo.ts" });
  expect(toolEvents[1].data).toMatchObject({ toolName: "search" });
  expect(toolEvents[1].data).not.toHaveProperty("checkedPath");
});

test("classifyResult routes to agent.run.failed with caller-supplied data", async () => {
  const providerCall: ProviderRunner<{ ok: false; reason: string }> = async () => ({
    ok: false,
    reason: "max-turns",
  });

  const { events } = await runAgent(
    {
      agentName: "test-agent",
      classifyResult: (r) =>
        r.ok === false
          ? { kind: "failed", data: { reason: r.reason } }
          : { kind: "completed" },
    },
    providerCall,
  );

  const finalEvent = events[events.length - 1];
  expect(finalEvent.kind).toBe("agent.run.failed");
  expect(finalEvent.data).toMatchObject({ reason: "max-turns" });
});

test("provider exception emits agent.run.failed and rethrows", async () => {
  const observer = startWorkflowObserver({
    workflowName: "test-workflow",
    runId: "run_workflow_3",
    sinks: [],
  });
  const providerCall: ProviderRunner<unknown> = async () => {
    throw new Error("provider crashed");
  };

  await expect(
    runAgent({ agentName: "test-agent", observer }, providerCall),
  ).rejects.toThrow("provider crashed");

  const events = observer.drain();
  const failed = events.find((e) => e.kind === "agent.run.failed");
  expect(failed).toBeDefined();
  expect(failed?.data).toMatchObject({ error: "provider crashed" });
});

test("startData merges into agent.run.started", async () => {
  const providerCall: ProviderRunner<{ ok: true }> = async () => ({ ok: true });
  const { events } = await runAgent(
    {
      agentName: "test-agent",
      startData: { provider: "openrouter", model: "gpt-4" },
    },
    providerCall,
  );
  const started = events.find((e) => e.kind === "agent.run.started");
  expect(started?.data).toMatchObject({ provider: "openrouter", model: "gpt-4" });
});

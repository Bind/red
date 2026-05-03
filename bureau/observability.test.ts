import { expect, test } from "bun:test";
import type { WideEvent, WideEventSink } from "../pkg/daemons/src/wide-events";
import { startWorkflowObserver, withWorkflowRun } from "./observability";

test("startWorkflowObserver buffers events tagged with run id and workflow name", () => {
  const observer = startWorkflowObserver({
    workflowName: "test-workflow",
    workflowRunId: "run_test_1",
    sinks: [],
  });
  observer.event("custom.event", { hello: "world" });
  const events = observer.drain();
  expect(events).toHaveLength(1);
  expect(events[0].kind).toBe("custom.event");
  expect(events[0].route_name).toBe("test-workflow");
  expect(events[0].data).toMatchObject({
    workflowRunId: "run_test_1",
    workflowName: "test-workflow",
    hello: "world",
  });
});

test("step emits started/completed bracket on success", async () => {
  const observer = startWorkflowObserver({
    workflowName: "test-workflow",
    workflowRunId: "run_test_2",
    sinks: [],
  });
  const result = await observer.step("sandbox.create", async (step) => {
    step.event("sandbox.created", { provider: "just-bash" });
    return "ok";
  });
  expect(result).toBe("ok");
  const kinds = observer.drain().map((e) => e.kind);
  expect(kinds).toEqual([
    "workflow.step.started",
    "sandbox.created",
    "workflow.step.completed",
  ]);
});

test("step emits failed and rethrows on error", async () => {
  const observer = startWorkflowObserver({
    workflowName: "test-workflow",
    workflowRunId: "run_test_3",
    sinks: [],
  });
  await expect(
    observer.step("boom", async () => {
      throw new Error("nope");
    }),
  ).rejects.toThrow("nope");
  const events = observer.drain();
  expect(events.map((e) => e.kind)).toEqual([
    "workflow.step.started",
    "workflow.step.failed",
  ]);
  expect(events[1].data).toMatchObject({ step: "boom", status: "failed" });
});

test("withWorkflowRun wraps run lifecycle and forwards result", async () => {
  const captured: string[] = [];
  const sink: WideEventSink = (event: WideEvent) => {
    captured.push(event.kind);
  };
  const result = await withWorkflowRun(
    {
      workflowName: "test-workflow",
      workflowRunId: "run_test_4",
      sinks: [sink],
    },
    async ({ observer }) => {
      observer.event("inner.event");
      return 42;
    },
  );
  expect(result).toBe(42);
  expect(captured).toEqual([
    "workflow.run.started",
    "inner.event",
    "workflow.run.completed",
  ]);
});

test("withWorkflowRun emits run.failed and rethrows", async () => {
  const captured: string[] = [];
  const sink: WideEventSink = (event: WideEvent) => {
    captured.push(event.kind);
  };
  await expect(
    withWorkflowRun(
      { workflowName: "test-workflow", workflowRunId: "run_test_5", sinks: [sink] },
      async () => {
        throw new Error("kaboom");
      },
    ),
  ).rejects.toThrow("kaboom");
  expect(captured).toEqual([
    "workflow.run.started",
    "workflow.run.failed",
  ]);
});

test("workflow and agent events share the same workflowRunId join key", async () => {
  const observer = startWorkflowObserver({
    workflowName: "test-workflow",
    workflowRunId: "run_test_join",
    sinks: [],
  });

  observer.event("workflow.run.started");
  observer.emit({
    event_id: "evt_join",
    kind: "agent.run.started",
    route_name: "test-agent",
    ts: new Date().toISOString(),
    data: {
      workflowRunId: observer.workflowRunId,
      workflowName: observer.workflowName,
      agentName: "test-agent",
      agentRunId: "agent_1",
    },
  });

  const events = observer.drain();
  expect(events.map((event) => event.data.workflowRunId)).toEqual([
    "run_test_join",
    "run_test_join",
  ]);
});

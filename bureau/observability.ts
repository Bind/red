import {
  type WideEvent,
  type WideEventSink,
  createWideEvent,
  memorySink,
  stdoutSink,
} from "../pkg/daemons/src/wide-events";

export type Logger = {
  info(message: string, attributes?: Record<string, unknown>): void;
  warn(message: string, attributes?: Record<string, unknown>): void;
  error(message: string, attributes?: Record<string, unknown>): void;
  debug(message: string, attributes?: Record<string, unknown>): void;
};

const noopLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

export type WorkflowEventData = Record<string, unknown>;

export type StepContext = {
  readonly stepName: string;
  event(kind: string, data?: WorkflowEventData): void;
};

export type WorkflowObserver = {
  readonly runId: string;
  readonly workflowName: string;
  step<T>(name: string, fn: (step: StepContext) => Promise<T>): Promise<T>;
  event(kind: string, data?: WorkflowEventData): void;
  emit(event: WideEvent): void;
  drain(): WideEvent[];
};

export type WorkflowContext = {
  runId: string;
  workflowName: string;
  logger: Logger;
  events: WorkflowObserver;
};

export type WorkflowObserverOptions = {
  workflowName: string;
  runId?: string;
  logger?: Logger;
  sinks?: WideEventSink[];
};

function generateRunId(workflowName: string): string {
  return `workflow_${workflowName}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export function startWorkflowObserver(options: WorkflowObserverOptions): WorkflowObserver {
  const runId = options.runId ?? generateRunId(options.workflowName);
  const buffer = memorySink();
  const sinks = options.sinks ?? [stdoutSink()];

  const dispatch = (event: WideEvent) => {
    buffer.emit(event);
    for (const sink of sinks) sink(event);
  };

  const emit = (kind: string, data: WorkflowEventData = {}) => {
    dispatch(
      createWideEvent({
        kind,
        route_name: options.workflowName,
        data: { runId, workflowName: options.workflowName, ...data },
      }),
    );
  };

  return {
    runId,
    workflowName: options.workflowName,
    event: emit,
    emit: dispatch,
    drain: buffer.drain,
    async step<T>(name, fn) {
      const startedAt = Date.now();
      emit("workflow.step.started", {
        step: name,
        startedAt: new Date(startedAt).toISOString(),
      });
      const stepCtx: StepContext = {
        stepName: name,
        event(kind, data = {}) {
          emit(kind, { step: name, ...data });
        },
      };
      try {
        const result = await fn(stepCtx);
        emit("workflow.step.completed", {
          step: name,
          durationMs: Date.now() - startedAt,
          status: "completed",
        });
        return result;
      } catch (error) {
        emit("workflow.step.failed", {
          step: name,
          durationMs: Date.now() - startedAt,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  };
}

export async function withWorkflowRun<T>(
  options: WorkflowObserverOptions,
  fn: (ctx: { observer: WorkflowObserver; logger: Logger }) => Promise<T>,
): Promise<T> {
  const observer = startWorkflowObserver(options);
  const logger = options.logger ?? noopLogger;
  const startedAt = Date.now();
  observer.event("workflow.run.started", {
    startedAt: new Date(startedAt).toISOString(),
  });
  try {
    const result = await fn({ observer, logger });
    observer.event("workflow.run.completed", {
      durationMs: Date.now() - startedAt,
      status: "completed",
    });
    return result;
  } catch (error) {
    observer.event("workflow.run.failed", {
      durationMs: Date.now() - startedAt,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

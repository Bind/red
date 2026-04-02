import type { DockerClawRunner } from "./runner";
import type { ClawRunTracker } from "./types";
import type {
  AgentRuntime,
  AgentRuntimeEvent,
  AgentRuntimeRunRequest,
  AgentRuntimeRunResult,
  AgentRuntimeSession,
} from "./runtime";

export interface LegacyClawCliAgentRuntimeConfig {
  runner: DockerClawRunner;
  tracker?: ClawRunTracker;
}

export class OpenCodeBatchAgentRuntime implements AgentRuntime {
  constructor(private readonly config: LegacyClawCliAgentRuntimeConfig) {}

  async startRun<TJson = unknown>(
    request: AgentRuntimeRunRequest<TJson>
  ): Promise<AgentRuntimeSession<TJson>> {
    const queue = new AsyncEventQueue<AgentRuntimeEvent>();
    const startedAt = Date.now();
    let sequence = 0;
    let runtimeSessionId: string | undefined;

    pushEvent(queue, request.identity.runId, ++sequence, {
      kind: "lifecycle",
      type: "session.started",
      status: "running",
      text: `Run ${request.identity.runId} started`,
    });

    const resultPromise = this.config.runner
      .run<TJson>({
        repo: request.workspace.repo,
        headRef: request.workspace.headRef,
        baseRef: request.workspace.baseRef,
        setupScript: request.workspace.setupScript,
        instructions: request.prompt.instructions,
        output: {
          json: request.output.expectJson,
          files: request.output.expectedFiles,
        },
        metadata: {
          runId: request.identity.runId,
          jobName: request.identity.jobName,
          jobId: request.identity.jobId,
          changeId: request.identity.changeId,
          workerId: request.identity.workerId,
        },
        parseJson: request.output.parseJson,
        timeoutMs: request.timeoutMs,
        onLog: (line) => {
          const event = normalizeRunnerLine(request.identity.runId, ++sequence, line);
          if (!runtimeSessionId && event.runtimeSessionId) {
            runtimeSessionId = event.runtimeSessionId;
          }
          queue.push(event);
        },
      })
      .then(async (result): Promise<AgentRuntimeRunResult<TJson>> => {
        const trackedRun = this.config.tracker?.getByRunId(request.identity.runId);
        if (!runtimeSessionId && trackedRun?.codexSessionId) {
          runtimeSessionId = trackedRun.codexSessionId;
        }

        if (trackedRun?.rolloutPath) {
          pushEvent(queue, request.identity.runId, ++sequence, {
            runtimeSessionId,
            kind: "artifact",
            type: "artifact.available",
            data: {
              artifactKind: "events",
              key: trackedRun.rolloutPath,
              contentType: "application/x-ndjson",
            },
          });
        }

        if (!result.ok) {
          pushEvent(queue, request.identity.runId, ++sequence, {
            runtimeSessionId,
            kind: "lifecycle",
            type: "session.failed",
            status: "failed",
            data: {
              errorType: result.error?.type ?? null,
              errorMessage: result.error?.message ?? "Runtime failed",
            },
            text: result.error?.message ?? "Runtime failed",
          });
          queue.close();
          return {
            status: "failed",
            runtimeSessionId,
            durationMs: result.durationMs,
            files: [],
            errorType: result.error?.type,
            errorMessage: result.error?.message ?? "Runtime failed",
          };
        }

        if (request.output.expectJson) {
          pushEvent(queue, request.identity.runId, ++sequence, {
            runtimeSessionId,
            kind: "artifact",
            type: "artifact.available",
            data: {
              artifactKind: "result",
              contentType: "application/json",
            },
          });
        }

        for (const file of result.files) {
          pushEvent(queue, request.identity.runId, ++sequence, {
            runtimeSessionId,
            kind: "artifact",
            type: "artifact.available",
            data: {
              artifactKind: "file",
              path: file.path,
            },
          });
        }

        pushEvent(queue, request.identity.runId, ++sequence, {
          runtimeSessionId,
          kind: "lifecycle",
          type: "result.completed",
          status: "completed",
        });
        pushEvent(queue, request.identity.runId, ++sequence, {
          runtimeSessionId,
          kind: "lifecycle",
          type: "session.completed",
          status: "completed",
          data: { durationMs: result.durationMs },
        });
        queue.close();

        return {
          status: "completed",
          runtimeSessionId,
          durationMs: result.durationMs,
          json: result.json,
          files: result.files,
        };
      })
      .catch((error): AgentRuntimeRunResult<TJson> => {
        const errorMessage = error instanceof Error ? error.message : String(error);
        pushEvent(queue, request.identity.runId, ++sequence, {
          runtimeSessionId,
          kind: "lifecycle",
          type: "session.failed",
          status: "failed",
          data: {
            errorType: "runtime_error",
            errorMessage,
          },
          text: errorMessage,
        });
        queue.close();
        return {
          status: "failed",
          durationMs: Date.now() - startedAt,
          files: [],
          errorType: "runtime_error",
          errorMessage,
        };
      });

    return {
      identity: request.identity,
      events: queue,
      result: () => resultPromise,
      cancel: async () => {
        pushEvent(queue, request.identity.runId, ++sequence, {
          runtimeSessionId,
          kind: "lifecycle",
          type: "status.updated",
          status: "cancelled",
          text: "Cancellation is not implemented for the batch runtime",
        });
      },
    };
  }
}

export const LegacyClawCliAgentRuntime = OpenCodeBatchAgentRuntime;

function pushEvent(
  queue: AsyncEventQueue<AgentRuntimeEvent>,
  runId: string,
  sequence: number,
  partial: Omit<AgentRuntimeEvent, "id" | "runId" | "sequence" | "timestamp">
): void {
  queue.push({
    id: `${runId}:${sequence}`,
    runId,
    sequence,
    timestamp: new Date().toISOString(),
    ...partial,
  });
}

function normalizeRunnerLine(runId: string, sequence: number, line: string): AgentRuntimeEvent {
  const timestamp = new Date().toISOString();

  try {
    const raw = JSON.parse(line) as Record<string, any>;
    const sessionId = typeof raw.sessionID === "string" ? raw.sessionID : undefined;

    if (raw.type === "step_start") {
      return {
        id: `${runId}:${sequence}`,
        runId,
        runtimeSessionId: sessionId,
        timestamp,
        sequence,
        kind: "lifecycle",
        type: "step.started",
        status: "running",
        data: raw,
        raw,
      };
    }

    if (raw.type === "step_finish") {
      return {
        id: `${runId}:${sequence}`,
        runId,
        runtimeSessionId: sessionId,
        timestamp,
        sequence,
        kind: "lifecycle",
        type: "step.completed",
        status: raw.part?.reason === "stop" ? "completed" : "running",
        data: raw,
        raw,
      };
    }

    if (raw.type === "text") {
      return {
        id: `${runId}:${sequence}`,
        runId,
        runtimeSessionId: sessionId,
        timestamp,
        sequence,
        kind: "message",
        type: "message.completed",
        role: "assistant",
        text: typeof raw.part?.text === "string" ? raw.part.text : line,
        data: raw,
        raw,
      };
    }

    return {
      id: `${runId}:${sequence}`,
      runId,
      runtimeSessionId: sessionId,
      timestamp,
      sequence,
      kind: "custom",
      type: typeof raw.type === "string" ? raw.type : "custom",
      data: raw,
      raw,
    };
  } catch {
    return {
      id: `${runId}:${sequence}`,
      runId,
      timestamp,
      sequence,
      kind: "message",
      type: "message.completed",
      role: "system",
      text: line,
    };
  }
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private done = false;

  push(value: T): void {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ value, done: false });
      return;
    }
    this.values.push(value);
  }

  close(): void {
    if (this.done) return;
    this.done = true;
    while (this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      waiter?.({ value: undefined as T, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.values.length > 0) {
          const value = this.values.shift() as T;
          return Promise.resolve({ value, done: false });
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as T, done: true });
        }
        return new Promise<IteratorResult<T>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

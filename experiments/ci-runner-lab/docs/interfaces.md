# CI Runner Lab Interfaces

These are the first-pass interfaces for the jobs system.

They intentionally keep Nomad private behind a backend adapter.

## Ownership Split

Control plane:

- persists jobs and attempts
- enqueues and leases attempts
- exposes the HTTP API

Worker:

- leases one attempt at a time
- redeems the git credential grant
- validates bootstrap inputs
- chooses the pinned base image
- drives explicit lifecycle transitions
- polls execution status and logs
- chunks logs
- uploads logs and artifacts
- classifies terminal failures

Executor backend:

- starts execution on the substrate
- reports raw execution status
- returns raw stdout and stderr data
- exposes raw files from the artifacts directory

## Attempt Queue

```ts
interface AttemptQueue {
  enqueue(item: QueueItem): void;
  lease(workerId: string, capabilities: WorkerCapabilities): QueueItem | undefined;
}
```

Current default assumptions:

- one queue class: `default`
- one worker capability profile
- FIFO leasing
- one attempt per worker at a time

## Worker

```ts
interface Worker {
  tick(): Promise<boolean>;
  getState(): {
    workerId: string;
    runningAttemptId?: string;
  };
}
```

`tick()` does one lease-and-execute pass:

1. lease a compatible attempt
2. redeem credentials
3. validate bootstrap env
4. call the executor backend
5. poll status and logs in one loop
6. collect artifacts after terminal status
7. write final result

## Executor Backend

```ts
interface ExecutorBackend {
  start(bundle: ExecutionBundle): Promise<ExecutionHandle>;
  status(handle: ExecutionHandle): Promise<ExecutionStatus>;
  readLogs(handle: ExecutionHandle, cursor: number): Promise<LogReadResult>;
  listFiles(handle: ExecutionHandle, containerPath: string): Promise<FileEntry[]>;
}
```

The backend must not know about:

- MinIO object layout
- user-facing statuses
- git credential grants
- repo contract semantics
- retry policy

Those remain red-owned worker/control-plane concerns.

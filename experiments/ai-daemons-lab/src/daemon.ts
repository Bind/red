import type { WideEventSink } from "./wide-events";

export type DaemonContext = {
  now: () => Date;
  emit: WideEventSink;
  memory: Map<string, unknown>;
};

export type TickResult = {
  checked: number;
  healed: number;
  errors: number;
};

export type Daemon = {
  readonly name: string;
  readonly intervalMs: number;
  tick(ctx: DaemonContext): Promise<TickResult>;
};

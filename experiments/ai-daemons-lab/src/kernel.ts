import type { Daemon, DaemonContext, TickResult } from "./daemon";
import type { WideEventSink } from "./wide-events";

export type KernelOptions = {
  emit: WideEventSink;
  now?: () => Date;
};

type Scheduled = {
  daemon: Daemon;
  timer: ReturnType<typeof setInterval> | null;
  running: boolean;
};

export class DaemonKernel {
  private readonly scheduled = new Map<string, Scheduled>();
  private readonly memory = new Map<string, unknown>();
  private readonly emit: WideEventSink;
  private readonly now: () => Date;
  private started = false;

  constructor(options: KernelOptions) {
    this.emit = options.emit;
    this.now = options.now ?? (() => new Date());
  }

  register(daemon: Daemon): void {
    if (this.scheduled.has(daemon.name)) {
      throw new Error(`daemon already registered: ${daemon.name}`);
    }
    this.scheduled.set(daemon.name, { daemon, timer: null, running: false });
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const entry of this.scheduled.values()) {
      this.emit({
        kind: "daemon.started",
        route_name: entry.daemon.name,
        data: { intervalMs: entry.daemon.intervalMs },
      });
      entry.timer = setInterval(() => {
        void this.runTick(entry);
      }, entry.daemon.intervalMs);
    }
  }

  stop(): void {
    for (const entry of this.scheduled.values()) {
      if (entry.timer) {
        clearInterval(entry.timer);
        entry.timer = null;
      }
      this.emit({
        kind: "daemon.stopped",
        route_name: entry.daemon.name,
        data: {},
      });
    }
    this.started = false;
  }

  async tickOnce(name: string): Promise<TickResult> {
    const entry = this.scheduled.get(name);
    if (!entry) throw new Error(`unknown daemon: ${name}`);
    return this.runTick(entry);
  }

  private async runTick(entry: Scheduled): Promise<TickResult> {
    if (entry.running) {
      this.emit({
        kind: "daemon.tick.skipped",
        route_name: entry.daemon.name,
        data: { reason: "previous_tick_in_flight" },
      });
      return { checked: 0, healed: 0, errors: 0 };
    }
    entry.running = true;
    const startedAt = this.now();
    const ctx: DaemonContext = {
      now: this.now,
      emit: this.emit,
      memory: this.memory,
    };
    try {
      const result = await entry.daemon.tick(ctx);
      this.emit({
        kind: "daemon.tick.completed",
        route_name: entry.daemon.name,
        data: {
          checked: result.checked,
          healed: result.healed,
          errors: result.errors,
          durationMs: this.now().getTime() - startedAt.getTime(),
        },
      });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({
        kind: "daemon.tick.failed",
        route_name: entry.daemon.name,
        data: { error: message },
      });
      return { checked: 0, healed: 0, errors: 1 };
    } finally {
      entry.running = false;
    }
  }
}

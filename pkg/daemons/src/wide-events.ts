export type WideEvent = {
  event_id: string;
  kind: string;
  ts: string;
  route_name: string;
  data: Record<string, unknown>;
};

export type WideEventSink = (event: Omit<WideEvent, "event_id" | "ts">) => void;

let counter = 0;
function nextId(): string {
  counter += 1;
  return `evt_${Date.now().toString(36)}_${counter.toString(36)}`;
}

export function stdoutSink(): WideEventSink {
  return (event) => {
    const full: WideEvent = {
      event_id: nextId(),
      ts: new Date().toISOString(),
      ...event,
    };
    process.stdout.write(`${JSON.stringify(full)}\n`);
  };
}

export function memorySink(): { emit: WideEventSink; drain: () => WideEvent[] } {
  const events: WideEvent[] = [];
  return {
    emit(event) {
      events.push({
        event_id: nextId(),
        ts: new Date().toISOString(),
        ...event,
      });
    },
    drain() {
      const out = events.slice();
      events.length = 0;
      return out;
    },
  };
}

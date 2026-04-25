export type WideEvent = {
  event_id: string;
  kind: string;
  ts: string;
  route_name: string;
  data: Record<string, unknown>;
};

export type WideEventSink = (event: WideEvent) => void;

let counter = 0;
function nextId(): string {
  counter += 1;
  return `evt_${Date.now().toString(36)}_${counter.toString(36)}`;
}

export function createWideEvent(event: Omit<WideEvent, "event_id" | "ts">): WideEvent {
  return {
    event_id: nextId(),
    ts: new Date().toISOString(),
    ...event,
  };
}

export function stdoutSink(): WideEventSink {
  return (event) => {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  };
}

export function memorySink(): { emit: WideEventSink; drain: () => WideEvent[] } {
  const events: WideEvent[] = [];
  return {
    emit(event) {
      events.push(event);
    },
    drain() {
      const out = events.slice();
      events.length = 0;
      return out;
    },
  };
}

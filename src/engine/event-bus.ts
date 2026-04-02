import type { AgentSessionEvent } from "../types";

const BUFFER_SIZE = 200;
const CLEANUP_DELAY_MS = 30_000;

interface ChannelState {
  buffer: AgentSessionEvent[];
  listeners: Set<(event: AgentSessionEvent) => void>;
  doneListeners: Set<() => void>;
  completed: boolean;
}

export class EventBus {
  private channels = new Map<number, ChannelState>();

  private ensure(changeId: number): ChannelState {
    let ch = this.channels.get(changeId);
    if (!ch) {
      ch = { buffer: [], listeners: new Set(), doneListeners: new Set(), completed: false };
      this.channels.set(changeId, ch);
    }
    return ch;
  }

  emit(changeId: number, event: AgentSessionEvent): void {
    const ch = this.ensure(changeId);
    ch.buffer.push(event);
    if (ch.buffer.length > BUFFER_SIZE) {
      ch.buffer.splice(0, ch.buffer.length - BUFFER_SIZE);
    }
    for (const fn of ch.listeners) fn(event);
  }

  subscribe(
    changeId: number,
    onEvent: (event: AgentSessionEvent) => void,
    onDone: () => void,
  ): () => void {
    const ch = this.ensure(changeId);

    for (const event of ch.buffer) onEvent(event);

    if (ch.completed) {
      onDone();
      return () => {};
    }

    ch.listeners.add(onEvent);
    ch.doneListeners.add(onDone);

    return () => {
      ch.listeners.delete(onEvent);
      ch.doneListeners.delete(onDone);
    };
  }

  complete(changeId: number): void {
    const ch = this.channels.get(changeId);
    if (!ch) return;
    ch.completed = true;
    for (const fn of ch.doneListeners) fn();
    setTimeout(() => this.channels.delete(changeId), CLEANUP_DELAY_MS);
  }
}

const BUFFER_SIZE = 200;
const CLEANUP_DELAY_MS = 30_000;

interface ChannelState {
  buffer: string[];
  listeners: Set<(line: string) => void>;
  doneListeners: Set<() => void>;
  completed: boolean;
}

/**
 * In-memory pub/sub for streaming log lines keyed by changeId.
 * Late subscribers receive buffered history immediately.
 */
export class LogBus {
  private channels = new Map<number, ChannelState>();

  private ensure(changeId: number): ChannelState {
    let ch = this.channels.get(changeId);
    if (!ch) {
      ch = { buffer: [], listeners: new Set(), doneListeners: new Set(), completed: false };
      this.channels.set(changeId, ch);
    }
    return ch;
  }

  emit(changeId: number, line: string): void {
    const ch = this.ensure(changeId);
    ch.buffer.push(line);
    if (ch.buffer.length > BUFFER_SIZE) {
      ch.buffer.splice(0, ch.buffer.length - BUFFER_SIZE);
    }
    for (const fn of ch.listeners) fn(line);
  }

  /**
   * Subscribe to log lines for a change.
   * Immediately replays buffered lines, then streams new ones.
   * Returns an unsubscribe function.
   */
  subscribe(
    changeId: number,
    onLine: (line: string) => void,
    onDone: () => void,
  ): () => void {
    const ch = this.ensure(changeId);

    // Replay buffer
    for (const line of ch.buffer) onLine(line);

    // If already completed, signal done immediately
    if (ch.completed) {
      onDone();
      return () => {};
    }

    ch.listeners.add(onLine);
    ch.doneListeners.add(onDone);

    return () => {
      ch.listeners.delete(onLine);
      ch.doneListeners.delete(onDone);
    };
  }

  /** Signal that the log stream for this change is finished. */
  complete(changeId: number): void {
    const ch = this.channels.get(changeId);
    if (!ch) return;
    ch.completed = true;
    for (const fn of ch.doneListeners) fn();
    // Clean up after a delay so late-connecting clients can still get the buffer
    setTimeout(() => this.channels.delete(changeId), CLEANUP_DELAY_MS);
  }
}

/**
 * Per-chat event log with sequence numbers. The SSE stream and the long-poll
 * fallback both read from it, so a client that reconnects with `after=<seq>`
 * misses nothing (as long as the events are still retained).
 */

export type BridgeEvent = {
  seq: number;
  /** Changes every time the bridge starts; a client that sees a new epoch reloads the chat. */
  epoch: string;
  type: string;
  ts: number;
  turnId?: string;
  data: Record<string, unknown>;
};

export type SinceResult = {
  events: BridgeEvent[];
  /** True when events after `after` were already dropped; the client should reload the transcript. */
  gap: boolean;
};

export class EventLog {
  readonly epoch: string;
  readonly maxEvents: number;
  #events: BridgeEvent[] = [];
  #seq = 0;
  #listeners = new Set<(ev: BridgeEvent) => void>();

  constructor(epoch: string, maxEvents = 5000) {
    this.epoch = epoch;
    this.maxEvents = maxEvents;
  }

  get lastSeq(): number {
    return this.#seq;
  }

  append(type: string, data: Record<string, unknown> = {}, turnId?: string): BridgeEvent {
    this.#seq += 1;
    const ev: BridgeEvent = { seq: this.#seq, epoch: this.epoch, type, ts: Date.now(), data };
    if (turnId !== undefined) ev.turnId = turnId;
    this.#events.push(ev);
    if (this.#events.length > this.maxEvents) {
      this.#events.splice(0, this.#events.length - this.maxEvents);
    }
    for (const fn of this.#listeners) {
      try {
        fn(ev);
      } catch {
        // A broken subscriber must not break the log.
      }
    }
    return ev;
  }

  since(after: number): SinceResult {
    const first = this.#events[0];
    const gap = first !== undefined && after < first.seq - 1;
    return { events: this.#events.filter((e) => e.seq > after), gap };
  }

  subscribe(fn: (ev: BridgeEvent) => void): () => void {
    this.#listeners.add(fn);
    return () => {
      this.#listeners.delete(fn);
    };
  }

  /** Resolves when an event with seq > after exists, the timeout passes, or the signal aborts. */
  waitForNew(after: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (this.#seq > after) return Promise.resolve();
    return new Promise((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener('abort', finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      const unsubscribe = this.subscribe((ev) => {
        if (ev.seq > after) finish();
      });
      signal?.addEventListener('abort', finish, { once: true });
    });
  }
}

/** One SSE frame. JSON.stringify never emits raw newlines, so a single data line is safe. */
export function sseFrame(ev: BridgeEvent): string {
  return `id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`;
}

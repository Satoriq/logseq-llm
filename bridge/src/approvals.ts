import { randomUUID } from 'node:crypto';
import type { EventLog } from './events.ts';

/**
 * Write approvals.
 *
 * Manual: a write tool asks, the panel shows a card, and you click Apply, Reject, or
 * "Apply all" (this change plus every further change in the same answer). No answer within
 * the timeout, Stop, or the end of the turn counts as Reject.
 *
 * Auto (autoApply setting, or "Apply all" earlier in this answer): the card is a progress
 * record. Edits and deletes first wait a short grace period ("Applying in 2s… Abort").
 * Abort works during the grace period and, for batches, between items while applying.
 */

export type PreviewBody =
  | { kind: 'blocks'; text: string }
  | { kind: 'diff'; before: string; after: string }
  | { kind: 'diffs'; items: { before: string; after: string }[] }
  | { kind: 'remove'; text: string }
  | { kind: 'text'; text: string };

export type ApprovalRequest = {
  tool: string;
  /** e.g. 'Add 3 blocks to "AI Test"' */
  title: string;
  /** e.g. 'page "AI Test", at the end' */
  target: string;
  body: PreviewBody;
  warnings: string[];
  /** Set by the write tool when this graph's autoApply setting covers this change. */
  auto?: boolean;
  /** How long an auto-applied change waits before it runs (edits/deletes), so you can Abort. */
  graceMs?: number;
};

export type ApprovalView = ApprovalRequest & { id: string; chatId: string; turnId: string; createdAt: number };

export type Decision = {
  decision: 'apply' | 'reject';
  note?: string;
  reason?: 'user' | 'timeout' | 'cancelled' | 'auto' | 'no-panel' | 'aborted';
  /** Aborted when you click Abort while the change is being applied. */
  signal?: AbortSignal;
};

export type UserDecision = 'apply' | 'reject' | 'apply-all' | 'abort';

export type Outcome = 'applied' | 'rejected' | 'failed' | 'aborted';

type Entry = {
  view: ApprovalView;
  phase: 'waiting' | 'grace' | 'applying';
  abort: AbortController;
  resolve?: (d: Decision) => void;
  timer?: NodeJS.Timeout;
};

export class Approvals {
  readonly timeoutMs: number;
  readonly requireUi: boolean;
  #entries = new Map<string, Entry>();
  #events: (chatId: string) => EventLog;
  /** Turns where you clicked "Apply all". */
  #trusted = new Map<string, string>(); // turnId → chatId
  /** Panels that can show cards: open SSE streams per chat, and last long-poll time. */
  #streams = new Map<string, number>();
  #polled = new Map<string, number>();

  constructor(opts: { events: (chatId: string) => EventLog; timeoutMs?: number; requireUi?: boolean }) {
    this.#events = opts.events;
    this.timeoutMs = opts.timeoutMs ?? 10 * 60_000;
    this.requireUi = opts.requireUi ?? true;
  }

  // ---------- which panels can show cards ----------

  /** A panel that can show approval cards opened an event stream for this chat. Returns the detach function. */
  uiAttach(chatId: string): () => void {
    this.#streams.set(chatId, (this.#streams.get(chatId) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const n = (this.#streams.get(chatId) ?? 1) - 1;
      if (n <= 0) this.#streams.delete(chatId);
      else this.#streams.set(chatId, n);
    };
  }

  /** A card-capable panel long-polled this chat. */
  uiSeen(chatId: string): void {
    this.#polled.set(chatId, Date.now());
  }

  hasUi(chatId: string): boolean {
    return (this.#streams.get(chatId) ?? 0) > 0 || Date.now() - (this.#polled.get(chatId) ?? 0) < 45_000;
  }

  // ---------- requests ----------

  isTrusted(turnId: string): boolean {
    return this.#trusted.has(turnId);
  }

  request(chatId: string, turnId: string, req: ApprovalRequest): Promise<{ view: ApprovalView; decision: Decision }> {
    const auto = req.auto === true || this.#trusted.has(turnId);
    const view: ApprovalView = { ...req, auto, id: randomUUID(), chatId, turnId, createdAt: Date.now() };
    if (!auto) delete view.graceMs;
    const entry: Entry = { view, phase: auto ? 'grace' : 'waiting', abort: new AbortController() };
    this.#entries.set(view.id, entry);

    if (auto) {
      this.#emit(view, 'approval.request', view as unknown as Record<string, unknown>);
      const grace = Math.max(0, req.graceMs ?? 0);
      return new Promise((resolve) => {
        entry.resolve = (d) => resolve({ view, decision: d });
        if (grace === 0) return this.#start(view.id, { decision: 'apply', reason: 'auto' });
        entry.timer = setTimeout(() => this.#start(view.id, { decision: 'apply', reason: 'auto' }), grace);
      });
    }

    if (this.requireUi && !this.hasUi(chatId)) {
      // Nobody can see a card (panel closed, not running, or too old): don't hang for 10 minutes.
      this.#entries.delete(view.id);
      this.#emit(view, 'notice', {
        message: "A change needs your approval, but no Logseq AI panel that can show approval cards is open on this chat (update or reload the plugin). Nothing was changed.",
      });
      return Promise.resolve({ view, decision: { decision: 'reject', reason: 'no-panel' } });
    }
    return new Promise((resolve) => {
      entry.resolve = (d) => resolve({ view, decision: d });
      entry.timer = setTimeout(() => this.#settle(view.id, { decision: 'reject', reason: 'timeout' }), this.timeoutMs);
      this.#emit(view, 'approval.request', view as unknown as Record<string, unknown>);
    });
  }

  /**
   * Your answer. "apply-all" applies this one and auto-applies the rest of this answer.
   * "abort" stops an auto-applied change (during its grace period, or between batch items).
   * Returns false if the approval is unknown or can't take that answer any more.
   */
  decide(id: string, decision: UserDecision, note?: string): boolean {
    const e = this.#entries.get(id);
    if (!e) return false;
    if (decision === 'abort') {
      if (e.phase === 'grace') return this.#settle(id, { decision: 'reject', reason: 'aborted' });
      if (e.phase === 'applying') {
        e.abort.abort();
        return true;
      }
      return false;
    }
    if (e.phase !== 'waiting') return false;
    if (decision === 'apply-all') this.#trusted.set(e.view.turnId, e.view.chatId);
    if (decision === 'reject') return this.#settle(id, { decision: 'reject', reason: 'user', ...(note ? { note: note.slice(0, 2000) } : {}) });
    return this.#start(id, { decision: 'apply', reason: 'user' });
  }

  /** Ends everything still open in a chat (turn cancelled or ended); also forgets "Apply all" for its turns. */
  rejectAll(chatId: string, reason: 'cancelled' | 'timeout'): void {
    for (const [id, e] of this.#entries) {
      if (e.view.chatId !== chatId) continue;
      if (e.phase === 'applying') e.abort.abort();
      else this.#settle(id, { decision: 'reject', reason });
    }
    for (const [turnId, c] of this.#trusted) if (c === chatId) this.#trusted.delete(turnId);
  }

  /** Ends "Apply all" for a turn with no end of its own (a connected app that went quiet). */
  endTurn(turnId: string): void {
    this.#trusted.delete(turnId);
  }

  /** Approvals still waiting for your answer. */
  pending(chatId: string): ApprovalView[] {
    return [...this.#entries.values()].filter((e) => e.view.chatId === chatId && e.phase === 'waiting').map((e) => e.view);
  }

  get(id: string): ApprovalView | undefined {
    return this.#entries.get(id)?.view;
  }

  /** Progress of a batch being applied ("7 of 25"). */
  progress(view: { id: string; chatId: string; turnId: string }, done: number, total: number): void {
    this.#emit(view, 'approval.progress', { id: view.id, done, total });
  }

  /** How it ended (called by the write tool once it knows). */
  resolved(view: { id: string; chatId: string; turnId: string }, outcome: Outcome, detail: string): void {
    this.#entries.delete(view.id);
    this.#emit(view, 'approval.resolved', { id: view.id, outcome, detail });
  }

  // ---------- internals ----------

  #emit(view: { chatId: string; turnId: string }, type: string, data: Record<string, unknown>): void {
    this.#events(view.chatId).append(type, data, view.turnId);
  }

  /** Starts applying: the entry stays (phase "applying") until resolved(), so Abort still works. */
  #start(id: string, d: Decision): boolean {
    const e = this.#entries.get(id);
    if (!e || !e.resolve) return false;
    clearTimeout(e.timer);
    e.phase = 'applying';
    const resolve = e.resolve;
    delete e.resolve;
    this.#emit(e.view, 'approval.applying', { id });
    resolve({ ...d, signal: e.abort.signal });
    return true;
  }

  /** Ends without applying. */
  #settle(id: string, d: Decision): boolean {
    const e = this.#entries.get(id);
    if (!e || !e.resolve) return false;
    clearTimeout(e.timer);
    this.#entries.delete(id);
    const resolve = e.resolve;
    delete e.resolve;
    resolve(d);
    return true;
  }
}

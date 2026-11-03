import { randomUUID } from 'node:crypto';
import type { EventLog } from './events.ts';

/**
 * Pending write approvals. A write tool asks; the panel shows a card; the user clicks
 * Apply or Reject (POST /v1/approvals/:id). No answer within the timeout counts as Reject,
 * and so does cancelling the turn or the turn ending.
 */

export type PreviewBody =
  | { kind: 'blocks'; text: string }
  | { kind: 'diff'; before: string; after: string }
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
  /** Set by the write tool when this graph's autoApply setting covers this change: applied without waiting. */
  auto?: boolean;
};

export type ApprovalView = ApprovalRequest & { id: string; chatId: string; turnId: string; createdAt: number };

export type Decision = { decision: 'apply' | 'reject'; note?: string; reason?: 'user' | 'timeout' | 'cancelled' | 'auto' | 'no-panel' };

type Pending = { view: ApprovalView; resolve: (d: Decision) => void; timer: NodeJS.Timeout };

export class Approvals {
  readonly timeoutMs: number;
  #pending = new Map<string, Pending>();
  #events: (chatId: string) => EventLog;
  /** Panels that can show cards: open SSE streams per chat, and last long-poll time. */
  #streams = new Map<string, number>();
  #polled = new Map<string, number>();
  readonly requireUi: boolean;

  constructor(opts: { events: (chatId: string) => EventLog; timeoutMs?: number; requireUi?: boolean }) {
    this.#events = opts.events;
    this.timeoutMs = opts.timeoutMs ?? 10 * 60_000;
    this.requireUi = opts.requireUi ?? true;
  }

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

  request(chatId: string, turnId: string, req: ApprovalRequest): Promise<{ view: ApprovalView; decision: Decision }> {
    const view: ApprovalView = { ...req, id: randomUUID(), chatId, turnId, createdAt: Date.now() };
    if (req.auto) {
      // Covered by this graph's autoApply setting: shown as a record card, applied right away.
      this.#events(chatId).append('approval.request', view as unknown as Record<string, unknown>, turnId);
      return Promise.resolve({ view, decision: { decision: 'apply', reason: 'auto' } });
    }
    if (this.requireUi && !this.hasUi(chatId)) {
      // Nobody can see a card (panel closed on another chat, not running, or too old): don't hang for 10 minutes.
      this.#events(chatId).append(
        'notice',
        { message: "A change needs your approval, but no Logseq AI panel that can show approval cards is open on this chat (update or reload the plugin). Nothing was changed." },
        turnId,
      );
      return Promise.resolve({ view, decision: { decision: 'reject', reason: 'no-panel' } });
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.#finish(view.id, { decision: 'reject', reason: 'timeout' }), this.timeoutMs);
      this.#pending.set(view.id, { view, resolve: (decision) => resolve({ view, decision }), timer });
      this.#events(chatId).append('approval.request', view as unknown as Record<string, unknown>, turnId);
    });
  }

  /** The user's answer. Returns false if the approval is unknown or already settled. */
  decide(id: string, decision: 'apply' | 'reject', note?: string): boolean {
    return this.#finish(id, { decision, reason: 'user', ...(note ? { note: note.slice(0, 2000) } : {}) });
  }

  /** Rejects everything still waiting in a chat (turn cancelled or ended). */
  rejectAll(chatId: string, reason: 'cancelled' | 'timeout'): void {
    for (const [id, p] of this.#pending) if (p.view.chatId === chatId) this.#finish(id, { decision: 'reject', reason });
  }

  pending(chatId: string): ApprovalView[] {
    return [...this.#pending.values()].filter((p) => p.view.chatId === chatId).map((p) => p.view);
  }

  get(id: string): ApprovalView | undefined {
    return this.#pending.get(id)?.view;
  }

  #finish(id: string, d: Decision): boolean {
    const p = this.#pending.get(id);
    if (!p) return false;
    this.#pending.delete(id);
    clearTimeout(p.timer);
    p.resolve(d);
    return true;
  }

  /** Reports how an approval ended (called by the write tool once it knows the outcome). */
  resolved(view: { id: string; chatId: string; turnId: string }, outcome: 'applied' | 'rejected' | 'failed', detail: string): void {
    this.#events(view.chatId).append('approval.resolved', { id: view.id, outcome, detail }, view.turnId);
  }
}

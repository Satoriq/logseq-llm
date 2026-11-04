import type { BridgeClient } from './bridge';
import type { ApprovalView, BridgeEvent } from './types';

/**
 * Change cards: one per proposed write.
 * - Manual: Reject / Apply / "Apply all" (this and every further change in this answer).
 * - Auto (autoApply, or after "Apply all"): progress ("Applying in 2s…", "7/25") and Abort.
 * - A finished card collapses to one line after 1 s; click the line to open or close it.
 * - Two or more cards in one answer sit in a group, "5 changes · ✓ 4 · ✗ 1", which collapses
 *   1 s after its last card finishes and opens and closes the same way.
 * Text only via textContent (see render.ts).
 */

export const COLLAPSE_MS = 1000;

type Card = {
  view: ApprovalView;
  root: HTMLElement;
  state: HTMLElement;
  icon: HTMLElement;
  status: HTMLElement;
  actions: HTMLElement;
  group: Group;
  outcome: string | null;
  countdown?: ReturnType<typeof setInterval>;
};

type Group = { root: HTMLElement; head: HTMLButtonElement; body: HTMLElement; cards: Card[]; timer?: ReturnType<typeof setTimeout> };

export class ChangeCards {
  #doc: Document;
  #bridge: () => BridgeClient | null;
  #onChange: () => void;
  #cards = new Map<string, Card>();
  #groups = new WeakMap<HTMLElement, Group>();
  #applyAllHint: string;

  constructor(opts: { doc: Document; bridge: () => BridgeClient | null; onChange: () => void; applyAllHint?: string }) {
    this.#applyAllHint = opts.applyAllHint ?? 'Apply this and every other change in this answer without asking';
    this.#doc = opts.doc;
    this.#bridge = opts.bridge;
    this.#onChange = opts.onChange;
  }

  #h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
    const e = this.#doc.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  #button(cls: string, text: string, title: string, onClick: () => void): HTMLButtonElement {
    const b = this.#h('button', cls, text);
    b.type = 'button';
    b.title = title;
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      onClick();
    });
    return b;
  }

  #pre(cls: string, text: string): HTMLElement {
    return this.#h('pre', `lsai-card-pre ${cls}`, text);
  }

  #group(container: HTMLElement): Group {
    let g = this.#groups.get(container);
    if (g && g.root.isConnected) return g;
    const root = this.#h('div', 'lsai-changes');
    const head = this.#button('lsai-changes-head', '', 'Show or hide these changes', () => root.classList.toggle('lsai-collapsed'));
    head.hidden = true;
    const body = this.#h('div', 'lsai-changes-body');
    root.append(head, body);
    container.appendChild(root);
    g = { root, head, body, cards: [] };
    this.#groups.set(container, g);
    return g;
  }

  #updateGroup(g: Group): void {
    const n = g.cards.length;
    g.head.hidden = n < 2;
    if (n < 2) return;
    const ok = g.cards.filter((c) => c.outcome === 'applied').length;
    const bad = g.cards.filter((c) => c.outcome !== null && c.outcome !== 'applied').length;
    const open = n - ok - bad;
    g.head.textContent = `${n} changes${ok ? ` · ✓ ${ok}` : ''}${bad ? ` · ✗ ${bad}` : ''}${open ? ` · ${open} in progress` : ''}`;
    if (open === 0) {
      clearTimeout(g.timer);
      g.timer = setTimeout(() => g.root.classList.add('lsai-collapsed'), COLLAPSE_MS);
    } else {
      g.root.classList.remove('lsai-collapsed');
    }
  }

  /** Shows a card for a new approval (or a pending one after a reload). */
  show(a: ApprovalView, container: HTMLElement): void {
    if (this.#cards.has(a.id)) return;
    const group = this.#group(container);
    const root = this.#h('div', `lsai-card${a.auto ? ' lsai-card-auto' : ''}`);
    const head = this.#button('lsai-card-head', '', 'Show or hide details', () => root.classList.toggle('lsai-collapsed'));
    const icon = this.#h('span', 'lsai-card-icon', a.auto ? '⏳' : '?');
    const title = this.#h('span', 'lsai-card-title', a.title);
    const state = this.#h('span', 'lsai-card-state', a.auto ? 'applying…' : 'waiting for you');
    head.append(icon, title, state);

    const body = this.#h('div', 'lsai-card-body');
    // Auto cards keep the preview folded ("Preview"); manual cards show it, since you decide on it.
    const preview: HTMLElement = a.auto ? this.#h('details', 'lsai-card-more') : body;
    if (a.auto) preview.appendChild(this.#h('summary', undefined, 'Preview'));
    preview.appendChild(this.#h('div', 'lsai-card-target', a.target));
    const b = a.body;
    const pairs = b.kind === 'diffs' ? b.items : b.kind === 'diff' ? [{ before: b.before, after: b.after }] : null;
    if (pairs) {
      const box = this.#h('div', 'lsai-diffs');
      for (const d of pairs) {
        const pair = this.#h('div', 'lsai-diffpair');
        pair.append(this.#pre('lsai-before', d.before), this.#pre('lsai-after', d.after));
        box.appendChild(pair);
      }
      preview.appendChild(box);
    } else if (b.kind === 'blocks' || b.kind === 'remove' || b.kind === 'text') {
      preview.appendChild(this.#pre(b.kind === 'remove' ? 'lsai-remove' : '', b.text));
    }
    if (a.warnings.length > 0) {
      const ul = this.#h('ul', 'lsai-warnings');
      for (const w of a.warnings) ul.appendChild(this.#h('li', undefined, `⚠ ${w}`));
      preview.appendChild(ul);
    }
    if (a.auto) body.appendChild(preview);
    const actions = this.#h('div', 'lsai-card-actions');
    const status = this.#h('div', 'lsai-card-status');
    body.append(actions, status);
    root.append(head, body);
    group.body.appendChild(root);

    const card: Card = { view: a, root, state, icon, status, actions, group, outcome: null };
    this.#cards.set(a.id, card);
    group.cards.push(card);

    if (a.auto) {
      // Auto: details folded away, progress in the head line, Abort while it can still help.
      const abort = this.#button('lsai-reject', 'Abort', 'Stop this change', () => void this.#send(card, 'abort'));
      actions.appendChild(abort);
      const grace = a.graceMs ?? 0;
      if (grace > 0) {
        let left = Math.ceil(grace / 1000);
        state.textContent = `applying in ${left}s`;
        card.countdown = setInterval(() => {
          left -= 1;
          if (left > 0) state.textContent = `applying in ${left}s`;
          else clearInterval(card.countdown);
        }, 1000);
      }
    } else {
      const note = this.#h('input', 'lsai-note');
      note.type = 'text';
      note.placeholder = 'Note for the AI if you reject (optional)';
      const reject = this.#button('lsai-reject', 'Reject', 'Do not make this change', () => void this.#send(card, 'reject', note.value.trim()));
      const all = this.#button('lsai-apply-all', 'Apply all', this.#applyAllHint, () => void this.#send(card, 'apply-all'));
      const apply = this.#button('lsai-apply', a.tool === 'remove_block' ? 'Delete' : 'Apply', 'Make this change in your graph', () => void this.#send(card, 'apply'));
      actions.append(note, reject, all, apply);
      status.textContent = 'Nothing is written until you click Apply.';
    }
    this.#updateGroup(group);
    this.#onChange();
  }

  async #send(card: Card, decision: 'apply' | 'reject' | 'apply-all' | 'abort', note?: string): Promise<void> {
    const buttons = [...card.actions.querySelectorAll('button')];
    for (const x of buttons) x.disabled = true;
    card.state.textContent = decision === 'reject' ? 'rejecting…' : decision === 'abort' ? 'aborting…' : 'applying…';
    try {
      await this.#bridge()?.decide(card.view.id, decision, note || undefined);
    } catch (err) {
      card.status.textContent = `Could not send your answer: ${(err as Error).message}`;
      for (const x of buttons) x.disabled = false;
    }
  }

  /** Handles approval.* events. Returns true if the event was one of ours. */
  onEvent(ev: BridgeEvent, container: () => HTMLElement): boolean {
    switch (ev.type) {
      case 'approval.request':
        this.show(ev.data as unknown as ApprovalView, container());
        return true;
      case 'approval.applying': {
        const c = this.#cards.get(String(ev.data.id));
        if (!c) return true;
        clearInterval(c.countdown);
        c.state.textContent = 'applying…';
        // Abort can only stop a batch between items; a single change runs in one step.
        const batch = c.view.body.kind === 'diffs' && c.view.body.items.length > 1;
        if (!batch) c.actions.replaceChildren();
        return true;
      }
      case 'approval.progress': {
        const c = this.#cards.get(String(ev.data.id));
        if (c) c.state.textContent = `${String(ev.data.done)}/${String(ev.data.total)}`;
        return true;
      }
      case 'approval.resolved': {
        const c = this.#cards.get(String(ev.data.id));
        if (!c) return true;
        clearInterval(c.countdown);
        const outcome = String(ev.data.outcome);
        const detail = String(ev.data.detail ?? '');
        c.outcome = outcome;
        c.icon.textContent = outcome === 'applied' ? '✓' : '✗';
        c.state.textContent =
          outcome === 'applied'
            ? c.view.auto ? 'auto-applied' : 'applied'
            : outcome === 'aborted'
              ? `aborted${detail && detail !== 'aborted' ? ` (${detail})` : ''}`
              : outcome === 'failed'
                ? 'failed'
                : 'not applied';
        c.status.textContent = outcome === 'failed' ? `Failed: ${detail}` : outcome === 'applied' && !c.view.auto ? `Done: ${detail}` : '';
        c.actions.replaceChildren();
        c.root.classList.add(`lsai-card-${outcome}`);
        // Finished: fold to one line after a moment (click it to open again).
        setTimeout(() => c.root.classList.add('lsai-collapsed'), COLLAPSE_MS);
        this.#updateGroup(c.group);
        return true;
      }
      default:
        return false;
    }
  }

  /** Takes a finished card off the screen. */
  drop(id: string): void {
    const c = this.#cards.get(id);
    if (!c || c.outcome === null) return;
    this.#cards.delete(id);
    c.root.remove();
    c.group.cards = c.group.cards.filter((x) => x !== c);
    if (c.group.cards.length === 0) c.group.root.remove();
    else this.#updateGroup(c.group);
  }

  clear(): void {
    for (const c of this.#cards.values()) clearInterval(c.countdown);
    this.#cards.clear();
  }
}

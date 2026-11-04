import type { BridgeClient, ConnState } from './bridge';
import { ChangeCards, COLLAPSE_MS } from './changes';
import type { Tab } from './layout';
import { renderMarkdown } from './render';
import type { BridgeEvent, ChatMeta, EditorPort, Effort, Prefs, ProviderInfo, ShareState, StoredMessage } from './types';

/**
 * One chat, in one tab: its own model pickers, messages, composer and event stream, so several
 * can run side by side. Built with createElement/textContent only (see render.ts for the rules).
 * A hidden tab follows nothing unless a reply is running, so open tabs don't hold connections.
 */

export type ViewDeps = {
  doc: Document;
  /** null when the bridge URL/token isn't configured yet. */
  bridge: BridgeClient | null;
  editor: EditorPort;
  prefs: { get: () => Prefs; set: (p: Partial<Prefs>) => void };
  providers: () => ProviderInfo[];
  /** Something the tab row shows changed, or something worth saving. */
  onChange: () => void;
  onFocus: () => void;
  onChatCreated: (chat: ChatMeta) => void;
  onConn: (s: ConnState) => void;
  onError: (err: unknown) => void;
  /** A shared preference changed here (page chip, web search), so the other views follow. */
  onPrefs: () => void;
  onBridgeRestart: () => void;
};

const EFFORT_LABEL: Record<Effort, string> = {
  auto: 'Auto effort',
  off: 'Off',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};

type Live = {
  turnId: string | undefined;
  root: HTMLElement;
  body: HTMLElement;
  /** Tool steps: a group that folds to "N steps · ✓ N" once the reply is done. */
  steps: HTMLElement;
  stepsHead: HTMLButtonElement;
  stepsBody: HTMLElement;
  /** You opened or closed the steps yourself: don't fold them for you. */
  stepsTouched: boolean;
  dots: HTMLElement;
  text: string;
  stepRows: Map<string, HTMLElement>;
};

/** "Claude (Pro, claude CLI)" → "Claude". */
export function shortLabel(p: ProviderInfo): string {
  return p.label.replace(/\s*\([^)]*\)/g, '');
}

export class ChatView {
  readonly root: HTMLElement;
  readonly tab: Tab;
  #d: ViewDeps;
  #doc: Document;
  #els!: {
    provider: HTMLSelectElement;
    model: HTMLSelectElement;
    effort: HTMLSelectElement;
    log: HTMLElement;
    share: HTMLElement;
    chips: HTMLElement;
    web: HTMLButtonElement;
    input: HTMLTextAreaElement;
    send: HTMLButtonElement;
    stop: HTMLButtonElement;
  };
  #title: string;
  #epoch: string | null = null;
  #unsub: (() => void) | null = null;
  #live: Live | null = null;
  #busy = false;
  #visible = false;
  #attention = false;
  #scrollTop: number | null = null;
  #page: { uuid: string; title: string; kind: 'page' | 'block' } | null = null;
  #pinned = new Map<string, string>();
  #changes: ChangeCards;
  #destroyed = false;
  /** The share question is open: nothing can be sent until it's answered. */
  #asking = false;
  /** A share check that had to wait for the reply to end. */
  #shareLater = false;
  #shareCheck = 0;

  constructor(tab: Tab, title: string, deps: ViewDeps) {
    this.tab = tab;
    this.#title = title;
    this.#d = deps;
    this.#doc = deps.doc;
    this.root = this.#h('div', 'lsai-view');
    this.root.hidden = true;
    this.#changes = new ChangeCards({ doc: deps.doc, bridge: () => this.#d.bridge, onChange: () => this.#scroll(true) });
    this.#build();
  }

  get title(): string {
    return this.#title;
  }

  get busy(): boolean {
    return this.#busy;
  }

  /** A card is waiting in a tab you aren't looking at. */
  get attention(): boolean {
    return this.#attention;
  }

  /** Nothing here yet, so opening a chat can use this tab. */
  get unused(): boolean {
    return this.tab.chatId === null && !this.#busy && this.#els.input.value.trim() === '';
  }

  // ---------- DOM helpers ----------

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
      onClick();
    });
    return b;
  }

  #build(): void {
    const head = this.#h('div', 'lsai-row lsai-view-head');
    const provider = this.#h('select', 'lsai-select lsai-provider');
    const model = this.#h('select', 'lsai-select');
    const effort = this.#h('select', 'lsai-select');
    provider.title = 'Provider';
    model.title = 'Model';
    effort.title = 'Effort';
    provider.addEventListener('change', () => {
      this.#d.prefs.set({ provider: provider.value });
      this.tab.provider = provider.value;
      this.#fillModels();
      this.#picked();
      void this.#checkShare();
    });
    model.addEventListener('change', () => {
      this.#d.prefs.set({ model: model.value });
      this.#fillEfforts();
      this.#picked();
    });
    effort.addEventListener('change', () => {
      this.#d.prefs.set({ effort: effort.value as Effort });
      this.#picked();
    });
    head.append(provider, model, effort);

    const log = this.#h('div', 'lsai-log');
    log.setAttribute('aria-live', 'polite');

    const foot = this.#h('div', 'lsai-foot');
    const share = this.#h('div', 'lsai-share');
    share.hidden = true;
    const chips = this.#h('div', 'lsai-chips');
    const input = this.#h('textarea', 'lsai-input');
    input.rows = 3;
    input.placeholder = 'Ask about your notes…';
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void this.send();
      } else if (e.key === 'Escape') {
        input.blur();
      }
    });
    const actions = this.#h('div', 'lsai-actions');
    const hint = this.#h('span', 'lsai-hint', 'Enter to send · Shift+Enter for a new line');
    const web = this.#button('lsai-icon lsai-web', '🌐', '', () => {
      this.#d.prefs.set({ web: !web.classList.contains('lsai-on') });
      this.#d.onPrefs();
    });
    web.hidden = true;
    const send = this.#button('lsai-send', 'Send', 'Send (Enter)', () => void this.send());
    const stop = this.#button('lsai-stop', 'Stop', 'Stop the reply', () => void this.#stop());
    stop.hidden = true;
    actions.append(hint, web, stop, send);
    foot.append(share, chips, input, actions);

    this.root.addEventListener('pointerdown', () => this.#d.onFocus());
    this.root.addEventListener('focusin', () => this.#d.onFocus());
    this.root.append(head, log, foot);
    this.#els = { provider, model, effort, log, share, chips, web, input, send, stop };
    this.#renderChips();
  }

  /** Remembered per tab, and as the starting point for new tabs. */
  #picked(): void {
    const { provider, model, effort } = this.#els;
    this.tab.provider = provider.value;
    this.tab.model = model.value;
    this.tab.effort = effort.value;
    this.#d.onChange();
  }

  // ---------- lifecycle ----------

  /** Loads the chat, or shows the empty state. */
  async load(): Promise<void> {
    this.#release();
    const id = this.tab.chatId;
    this.#els.log.replaceChildren();
    this.#changes.clear();
    this.#setBusy(false);
    if (!id) {
      this.#els.log.appendChild(this.#h('div', 'lsai-empty', 'Ask anything about your notes. The page you are on is sent as context; #private blocks never leave your Mac.'));
      return;
    }
    const b = this.#d.bridge;
    if (!b) return;
    let state;
    try {
      state = await b.chat(id);
    } catch (err) {
      this.#d.onError(err);
      return;
    }
    if (this.#destroyed || this.tab.chatId !== id) return;
    this.#title = state.chat.title;
    // A chat opened from the list continues on the model it last used.
    if (!this.tab.provider && state.chat.provider) {
      this.tab.provider = state.chat.provider;
      if (state.chat.model) this.tab.model = state.chat.model;
      if (state.chat.effort) this.tab.effort = state.chat.effort;
      this.fillProviders();
    }
    this.#epoch = state.epoch;
    this.#els.log.replaceChildren();
    for (const m of state.messages) this.#renderStored(m);
    if (state.busy) {
      // Reopened while a reply is running: keep Stop available and say what it's waiting for.
      this.#setBusy(true);
      const waiting = (state.approvals ?? []).length > 0;
      this.#ensureLive(undefined).dots.textContent = waiting ? 'Waiting for your approval (see the card below)…' : 'A reply is in progress…';
    }
    for (const a of state.approvals ?? []) this.#changes.show(a, this.#live?.root ?? this.#els.log);
    this.#scroll(true);
    this.#unsub = b.subscribe(id, state.lastSeq, (ev) => this.#onEvent(id, ev), (s) => this.#d.onConn(s));
    this.#d.onChange();
    void this.#checkShare();
  }

  /** Puts a chat into this tab. */
  async openChat(chatId: string, title: string): Promise<void> {
    this.tab.chatId = chatId;
    delete this.tab.provider;
    this.#title = title;
    await this.load();
  }

  #release(): void {
    this.#unsub?.();
    this.#unsub = null;
    this.#live = null;
  }

  setVisible(visible: boolean): void {
    if (this.#visible === visible) return;
    this.#visible = visible;
    this.root.hidden = !visible;
    if (visible) {
      this.#attention = false;
      if (!this.#unsub) void this.load();
      else this.#scroll(true);
    } else if (!this.#busy) {
      this.#release();
    }
  }

  /** Moving a view in the DOM resets its scroll position. One at the bottom stays there, even in a smaller pane. */
  keepScroll(): void {
    if (!this.#visible) this.#scrollTop = null;
    else this.#scrollTop = this.#nearBottom() ? this.#els.log.scrollHeight : this.#els.log.scrollTop;
  }

  restoreScroll(): void {
    if (this.#scrollTop !== null) this.#els.log.scrollTop = this.#scrollTop;
    this.#scrollTop = null;
  }

  destroy(): void {
    this.#destroyed = true;
    this.#unsub?.();
    this.#changes.clear();
  }

  focus(): void {
    this.#els.input.focus();
  }

  get focused(): boolean {
    return this.#doc.activeElement === this.#els.input;
  }

  setPage(page: { uuid: string; title: string; kind: 'page' | 'block' } | null): void {
    this.#page = page;
    this.#renderChips();
  }

  pin(blocks: { uuid: string; title: string }[]): void {
    for (const b of blocks) this.#pinned.set(b.uuid, b.title);
    this.#renderChips();
  }

  /** The page chip and web search are one choice for all tabs. */
  refreshPrefs(): void {
    this.#renderChips();
    this.#updateWeb();
  }

  // ---------- pickers ----------

  #option(select: HTMLSelectElement, value: string, label: string): void {
    const o = this.#h('option', undefined, label);
    o.value = value;
    select.appendChild(o);
  }

  fillProviders(): void {
    const { provider } = this.#els;
    const list = this.#d.providers();
    provider.replaceChildren();
    for (const p of list) {
      // "Claude (Pro, claude CLI)" → "Claude · cloud"; the full label is the tooltip.
      this.#option(provider, p.id, `${shortLabel(p)} · ${p.locality}`);
      const o = provider.lastElementChild as HTMLOptionElement | null;
      if (o) o.title = p.label;
    }
    const want = this.tab.provider ?? this.#d.prefs.get().provider;
    provider.value = list.some((p) => p.id === want) ? (want as string) : (list[0]?.id ?? '');
    this.#fillModels();
  }

  /** 🌐 shows only for providers that can search; on/off is remembered. */
  #updateWeb(): void {
    const { web, provider } = this.#els;
    const can = this.#d.providers().find((x) => x.id === provider.value)?.webSearch === true;
    const on = can && this.#d.prefs.get().web === true;
    web.hidden = !can;
    web.classList.toggle('lsai-on', on);
    web.setAttribute('aria-pressed', String(on));
    web.title = on ? 'Web search is on: Claude may search the internet for your messages. Click to turn off.' : 'Web search is off. Click to let Claude search the internet.';
  }

  #fillModels(): void {
    this.#updateWeb();
    const { provider, model } = this.#els;
    const p = this.#d.providers().find((x) => x.id === provider.value);
    model.replaceChildren();
    for (const m of p?.models ?? []) this.#option(model, m.id, m.label);
    const want = this.tab.model ?? this.#d.prefs.get().model;
    model.value = p?.models.some((m) => m.id === want) ? (want as string) : (p?.models[0]?.id ?? '');
    this.#fillEfforts();
  }

  #fillEfforts(): void {
    const { provider, model, effort } = this.#els;
    const m = this.#d.providers().find((x) => x.id === provider.value)?.models.find((x) => x.id === model.value);
    effort.replaceChildren();
    for (const e of m?.efforts ?? ['auto']) this.#option(effort, e, EFFORT_LABEL[e]);
    const want = (this.tab.effort ?? this.#d.prefs.get().effort) as Effort | undefined;
    effort.value = m?.efforts.includes(want as Effort) ? (want as string) : (m?.efforts[0] ?? 'auto');
  }

  // ---------- sharing a chat with a new model ----------

  /** Asks, if the model just picked hasn't seen what's in this chat. The bridge keeps it from the model until you say yes. */
  async #checkShare(): Promise<void> {
    const b = this.#d.bridge;
    const id = this.tab.chatId;
    const provider = this.#els.provider.value;
    const check = ++this.#shareCheck;
    this.#closeShare();
    if (!b || !id || !provider) return;
    if (this.#busy) {
      this.#shareLater = true;
      return;
    }
    let state: ShareState;
    try {
      state = await b.shareState(id, provider);
    } catch {
      return; // The bridge shares nothing by itself, so no question is safe.
    }
    if (check === this.#shareCheck && state.ask && !this.#destroyed) this.#askShare(id, provider, state);
  }

  #askShare(id: string, providerId: string, state: ShareState): void {
    const info = this.#d.providers().find((p) => p.id === providerId);
    const name = info ? shortLabel(info) : providerId;
    const n = state.unseen;
    const text = this.#h(
      'div',
      'lsai-share-text',
      `Share this chat with ${name}? It hasn't seen ${n} earlier message${n === 1 ? '' : 's'}.${state.local ? ` ${n === 1 ? 'It' : 'They'} may quote your #private notes.` : ''}`,
    );
    const answer = async (yes: boolean): Promise<void> => {
      for (const x of buttons) x.disabled = true;
      try {
        await this.#d.bridge?.share(id, providerId, yes);
        this.#closeShare();
        this.focus();
      } catch (err) {
        text.textContent = `Could not save your answer: ${(err as Error).message}`;
        for (const x of buttons) x.disabled = false;
      }
    };
    const buttons = [
      this.#button('lsai-btn2', 'No', `Keep the earlier messages from ${name}`, () => void answer(false)),
      this.#button('lsai-send', 'Yes', `Send the earlier messages to ${name}`, () => void answer(true)),
    ];
    const row = this.#h('div', 'lsai-actions');
    row.append(...buttons);
    this.#els.share.replaceChildren(text, row);
    this.#els.share.hidden = false;
    this.#asking = true;
    this.#updateSend();
  }

  #closeShare(): void {
    this.#els.share.hidden = true;
    this.#els.share.replaceChildren();
    this.#asking = false;
    this.#updateSend();
  }

  // ---------- context chips ----------

  #renderChips(): void {
    const c = this.#els.chips;
    c.replaceChildren();
    const includePage = this.#d.prefs.get().includePage !== false;
    if (this.#page) {
      const what = this.#page.kind === 'block' ? 'zoomed-in block' : 'page';
      const label = `${this.#page.kind === 'block' ? '▦' : '📄'} ${this.#page.title.slice(0, 50) || what}`;
      const b = this.#button(`lsai-ctx${includePage ? ' lsai-on' : ''}`, label, includePage ? `This ${what} is sent as context (click to stop)` : `Click to send this ${what} as context`, () => {
        this.#d.prefs.set({ includePage: !includePage });
        this.#d.onPrefs();
      });
      b.setAttribute('aria-pressed', String(includePage));
      c.appendChild(b);
    }
    for (const [uuid, title] of this.#pinned) {
      const b = this.#button('lsai-ctx lsai-on', `▦ ${title.slice(0, 40) || 'block'}  ×`, 'Pinned block (click to remove)', () => {
        this.#pinned.delete(uuid);
        this.#renderChips();
      });
      c.appendChild(b);
    }
  }

  // ---------- messages ----------

  #renderStored(m: StoredMessage): void {
    const text = m.parts.filter((p): p is { type: 'text'; text: string } => p.type === 'text').map((p) => p.text).join('');
    if (m.role === 'user') {
      this.#els.log.appendChild(this.#h('div', 'lsai-msg lsai-user', text));
      return;
    }
    const box = this.#h('div', 'lsai-msg lsai-assistant');
    const meta = [m.meta?.provider, m.meta?.model].filter(Boolean).join(' · ');
    if (meta) box.appendChild(this.#h('div', 'lsai-meta', meta));
    const body = this.#h('div', 'lsai-body');
    body.appendChild(renderMarkdown({ doc: this.#doc, editor: this.#d.editor }, text));
    box.appendChild(body);
    if (m.meta?.stopReason && m.meta.stopReason !== 'end') box.appendChild(this.#h('div', 'lsai-meta', `(${m.meta.stopReason})`));
    this.#els.log.appendChild(box);
  }

  // ---------- sending ----------

  async send(): Promise<void> {
    const b = this.#d.bridge;
    const text = this.#els.input.value.trim();
    if (!b || !text || this.#busy || this.#asking) return;
    const { provider, model, effort } = this.#els;
    if (!provider.value || !model.value) return;
    this.#setBusy(true);
    try {
      if (!this.tab.chatId) {
        const chat = await b.createChat(text.slice(0, 60));
        this.tab.chatId = chat.id;
        this.#title = chat.title;
        this.#d.onChatCreated(chat);
        this.#els.log.replaceChildren();
        this.#unsub = b.subscribe(chat.id, 0, (ev) => this.#onEvent(chat.id, ev), (s) => this.#d.onConn(s));
      }
      const includePage = this.#d.prefs.get().includePage !== false;
      this.#els.log.appendChild(this.#h('div', 'lsai-msg lsai-user', text));
      this.#scroll(true);
      this.#els.input.value = '';
      this.#picked();
      await b.send(this.tab.chatId, {
        text,
        provider: provider.value,
        model: model.value,
        effort: effort.value as Effort,
        context: {
          ...(includePage && this.#page ? { pageUuid: this.#page.uuid } : {}),
          blockUuids: [...this.#pinned.keys()],
        },
        ...(!this.#els.web.hidden && this.#els.web.classList.contains('lsai-on') ? { web: true } : {}),
      });
    } catch (err) {
      this.#setBusy(false);
      this.#els.input.value = text;
      this.#els.log.appendChild(this.#h('div', 'lsai-error', `Could not send: ${(err as Error).message}`));
      this.#scroll(true);
    }
  }

  async #stop(): Promise<void> {
    if (this.tab.chatId) await this.#d.bridge?.cancel(this.tab.chatId).catch(() => undefined);
  }

  #setBusy(busy: boolean): void {
    if (this.#busy !== busy) {
      this.#busy = busy;
      this.#d.onChange();
    }
    this.#els.stop.hidden = !busy;
    this.#updateSend();
  }

  #updateSend(): void {
    this.#els.send.disabled = this.#busy || this.#asking;
  }

  // ---------- streaming ----------

  #ensureLive(turnId: string | undefined): Live {
    if (this.#live && (turnId === undefined || this.#live.turnId === undefined || this.#live.turnId === turnId)) {
      if (turnId !== undefined) this.#live.turnId = turnId;
      return this.#live;
    }
    const root = this.#h('div', 'lsai-msg lsai-assistant lsai-streaming');
    const meta = this.#h('div', 'lsai-meta', [this.#els.provider.value, this.#els.model.value].filter(Boolean).join(' · '));
    const steps = this.#h('div', 'lsai-steps');
    const stepsBody = this.#h('div', 'lsai-steps-body');
    const stepsHead = this.#button('lsai-steps-head', '', 'Show or hide the steps', () => {
      live.stepsTouched = true;
      steps.classList.toggle('lsai-collapsed');
    });
    stepsHead.hidden = true;
    steps.append(stepsHead, stepsBody);
    const body = this.#h('div', 'lsai-body lsai-plain');
    const dots = this.#h('div', 'lsai-dots', '…');
    root.append(meta, steps, body, dots);
    this.#els.log.appendChild(root);
    const live: Live = { turnId, root, body, steps, stepsHead, stepsBody, stepsTouched: false, dots, text: '', stepRows: new Map() };
    this.#live = live;
    return live;
  }

  /** Two or more steps get a head line, "10 steps · ✓ 9 · ✗ 1", that opens and closes them. */
  #updateSteps(live: Live): void {
    const rows = [...live.stepsBody.children];
    const n = rows.length;
    live.stepsHead.hidden = n < 2;
    if (n < 2) return;
    const ok = rows.filter((r) => r.classList.contains('lsai-ok')).length;
    const bad = rows.filter((r) => r.classList.contains('lsai-fail')).length;
    const open = n - ok - bad;
    live.stepsHead.textContent = `${n} steps${ok ? ` · ✓ ${ok}` : ''}${bad ? ` · ✗ ${bad}` : ''}${open ? ` · ${open} running` : ''}`;
  }

  #onEvent(chatId: string, ev: BridgeEvent): void {
    if (this.#destroyed || chatId !== this.tab.chatId) return;
    if (ev.type === 'log.gap' || (this.#epoch !== null && ev.epoch && ev.epoch !== this.#epoch)) {
      // The bridge restarted or events were dropped: reload the transcript.
      const waiting = this.#busy;
      this.#epoch = ev.epoch || null;
      void this.load().then(() => {
        if (waiting && !this.#busy) this.#els.log.appendChild(this.#h('div', 'lsai-notice', 'The bridge restarted, so this reply was lost. Send your message again.'));
      });
      this.#d.onBridgeRestart();
      return;
    }
    this.#epoch = ev.epoch || this.#epoch;
    const near = this.#nearBottom();
    if (ev.type === 'approval.request' && ev.data.auto !== true && !this.#visible) {
      this.#attention = true;
      this.#d.onChange();
    }
    if (this.#changes.onEvent(ev, () => this.#ensureLive(ev.turnId).root)) {
      if (ev.type === 'approval.resolved' && this.#live) this.#live.dots.textContent = '…';
      this.#scroll(near);
      return;
    }
    switch (ev.type) {
      case 'turn.start': {
        this.#setBusy(true);
        const live = this.#ensureLive(ev.turnId);
        const meta = live.root.querySelector('.lsai-meta');
        if (meta) meta.textContent = [ev.data.provider, ev.data.model, ev.data.locality === 'cloud' ? 'cloud' : 'local', ev.data.web === true ? '🌐 web' : ''].filter(Boolean).join(' · ');
        break;
      }
      case 'text.delta': {
        const live = this.#ensureLive(ev.turnId);
        live.text += String(ev.data.text ?? '');
        live.body.textContent = live.text; // plain text while streaming; Markdown at the end
        live.dots.hidden = true;
        break;
      }
      case 'thinking.delta': {
        const live = this.#ensureLive(ev.turnId);
        if (!live.text) live.dots.textContent = 'Thinking…';
        break;
      }
      case 'tool.start': {
        const live = this.#ensureLive(ev.turnId);
        const row = this.#h('div', 'lsai-step', `⋯ ${String(ev.data.label ?? ev.data.name ?? 'working')}`);
        live.stepsBody.appendChild(row);
        live.stepRows.set(String(ev.data.callId), row);
        this.#updateSteps(live);
        live.dots.hidden = false;
        live.dots.textContent = '…';
        break;
      }
      case 'tool.end': {
        const live = this.#ensureLive(ev.turnId);
        const row = live.stepRows.get(String(ev.data.callId));
        if (row) {
          const label = (row.textContent ?? '').replace(/^⋯ /, '');
          const hidden = Number(ev.data.hiddenCount ?? 0);
          row.textContent = ev.data.ok
            ? `✓ ${label}${hidden > 0 ? ` · ${hidden} hidden by your privacy settings` : ''}`
            : `✗ ${label}: ${String(ev.data.summary ?? 'failed')}`;
          row.classList.add(ev.data.ok ? 'lsai-ok' : 'lsai-fail');
          this.#updateSteps(live);
        }
        break;
      }
      case 'tool.waiting': {
        const live = this.#ensureLive(ev.turnId);
        live.dots.hidden = false;
        live.dots.textContent = 'Waiting for your approval…';
        break;
      }
      case 'notice': {
        const target = this.#live?.root ?? this.#els.log;
        target.appendChild(this.#h('div', 'lsai-notice', String(ev.data.message ?? '')));
        break;
      }
      case 'error': {
        const target = this.#live?.root ?? this.#els.log;
        target.appendChild(this.#h('div', 'lsai-error', String(ev.data.message ?? 'error')));
        break;
      }
      case 'turn.end': {
        const live = this.#live;
        if (live) {
          live.body.classList.remove('lsai-plain');
          live.body.replaceChildren(renderMarkdown({ doc: this.#doc, editor: this.#d.editor }, live.text));
          live.dots.remove();
          live.root.classList.remove('lsai-streaming');
          // Like change groups: once the reply is done, several steps fold to their head line.
          if (live.stepRows.size >= 2 && !live.stepsTouched) {
            setTimeout(() => {
              if (!live.stepsTouched) live.steps.classList.add('lsai-collapsed');
            }, COLLAPSE_MS);
          }
          const reason = String(ev.data.stopReason ?? 'end');
          if (reason !== 'end') live.root.appendChild(this.#h('div', 'lsai-meta', `(${reason})`));
        }
        this.#live = null;
        this.#attention = false;
        this.#setBusy(false);
        if (!this.#visible) this.#release();
        if (this.#shareLater) {
          this.#shareLater = false;
          void this.#checkShare();
        }
        break;
      }
      default:
        break;
    }
    this.#scroll(near);
  }

  #nearBottom(): boolean {
    const l = this.#els.log;
    return l.scrollHeight - l.scrollTop - l.clientHeight < 80;
  }

  #scroll(force: boolean): void {
    if (force) this.#els.log.scrollTop = this.#els.log.scrollHeight;
  }
}

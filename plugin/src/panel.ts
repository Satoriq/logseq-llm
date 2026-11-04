import { BridgeError } from './bridge';
import type { BridgeClient, ConnState } from './bridge';
import { ChangeCards } from './changes';
import { renderMarkdown } from './render';
import { PANEL_VERSION } from './version';
import type { BridgeEvent, ChatMeta, Effort, EditorPort, ProviderInfo, StoredMessage } from './types';

/**
 * The chat panel UI. Built with createElement/textContent only (see render.ts for the rules).
 * It depends on nothing Logseq-specific except the EditorPort, so it can be tested in a
 * plain browser page.
 */

export type Prefs = { provider?: string; model?: string; effort?: Effort; chatId?: string; includePage?: boolean };

export type PanelDeps = {
  doc: Document;
  /** null when the bridge URL/token isn't configured yet. */
  bridge: BridgeClient | null;
  editor: EditorPort;
  prefs: { get: () => Prefs; set: (p: Partial<Prefs>) => void };
  onClose: () => void;
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
  steps: HTMLElement;
  dots: HTMLElement;
  text: string;
  stepRows: Map<string, HTMLElement>;
};

export class Panel {
  readonly root: HTMLElement;
  #d: PanelDeps;
  #doc: Document;
  #els!: {
    status: HTMLElement;
    chatSelect: HTMLSelectElement;
    provider: HTMLSelectElement;
    model: HTMLSelectElement;
    effort: HTMLSelectElement;
    log: HTMLElement;
    foot: HTMLElement;
    instrBtn: HTMLButtonElement;
    chips: HTMLElement;
    input: HTMLTextAreaElement;
    send: HTMLButtonElement;
    stop: HTMLButtonElement;
  };
  #providers: ProviderInfo[] = [];
  #bridgeVersion = '?';
  #chats: ChatMeta[] = [];
  #chatId: string | null = null;
  #epoch: string | null = null;
  #unsub: (() => void) | null = null;
  #live: Live | null = null;
  #busy = false;
  #page: { uuid: string; title: string; kind: 'page' | 'block' } | null = null;
  #pinned = new Map<string, string>();
  #changes: ChangeCards;
  #destroyed = false;
  /** The open instructions editor, if any. */
  #instr: { root: HTMLElement; close: (force?: boolean) => void } | null = null;

  constructor(root: HTMLElement, deps: PanelDeps) {
    this.root = root;
    this.#d = deps;
    this.#doc = deps.doc;
    this.#changes = new ChangeCards({ doc: deps.doc, bridge: () => this.#d.bridge, onChange: () => this.#scroll(true) });
    this.#build();
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
    const head = this.#h('div', 'lsai-head');
    const row1 = this.#h('div', 'lsai-row');
    const chatSelect = this.#h('select', 'lsai-select lsai-chat');
    chatSelect.title = 'Chats';
    chatSelect.addEventListener('change', () => void this.#selectChat(chatSelect.value || null));
    const instrBtn = this.#button('lsai-icon', '✎', 'Your instructions for the AI', () => void this.#toggleInstructions());
    row1.append(
      chatSelect,
      this.#button('lsai-icon', '＋', 'New chat', () => void this.#selectChat(null)),
      instrBtn,
      this.#button('lsai-icon', '×', 'Close the panel', () => this.#d.onClose()),
    );
    const row2 = this.#h('div', 'lsai-row');
    const provider = this.#h('select', 'lsai-select lsai-provider');
    const model = this.#h('select', 'lsai-select');
    const effort = this.#h('select', 'lsai-select');
    provider.title = 'Provider';
    model.title = 'Model';
    effort.title = 'Effort';
    provider.addEventListener('change', () => {
      this.#d.prefs.set({ provider: provider.value });
      this.#fillModels();
    });
    model.addEventListener('change', () => {
      this.#d.prefs.set({ model: model.value });
      this.#fillEfforts();
    });
    effort.addEventListener('change', () => this.#d.prefs.set({ effort: effort.value as Effort }));
    row2.append(provider, model, effort);
    const status = this.#h('div', 'lsai-status', 'Connecting…');
    head.append(row1, row2, status);

    const log = this.#h('div', 'lsai-log');
    log.setAttribute('aria-live', 'polite');

    const foot = this.#h('div', 'lsai-foot');
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
    const send = this.#button('lsai-send', 'Send', 'Send (Enter)', () => void this.send());
    const stop = this.#button('lsai-stop', 'Stop', 'Stop the reply', () => void this.#stop());
    stop.hidden = true;
    actions.append(hint, stop, send);
    foot.append(chips, input, actions);

    // Typing in the panel must not trigger Logseq's keyboard shortcuts.
    for (const type of ['keydown', 'keyup', 'keypress'] as const) {
      this.root.addEventListener(type, (e) => e.stopPropagation());
    }

    this.root.append(head, log, foot);
    this.#els = { status, chatSelect, provider, model, effort, log, foot, instrBtn, chips, input, send, stop };
    this.#renderChips();
  }

  // ---------- your instructions ----------

  /** Opens the editor in place of the chat, or closes it. */
  async #toggleInstructions(): Promise<void> {
    if (this.#instr) {
      this.#instr.close();
      return;
    }
    const b = this.#d.bridge;
    const root = this.#h('div', 'lsai-instr');
    const title = this.#h('div', 'lsai-instr-head');
    title.append(this.#h('strong', undefined, 'Your instructions'), this.#h('span', 'lsai-hint', 'kept on this Mac · every chat'));
    const help = this.#h(
      'div',
      'lsai-instr-help',
      'Tell the AI how to work for you: language, tone and length of answers, what you do, how your notes are organized. ' +
        'Used from your next message, in every chat. Privacy rules and approvals always stay on.',
    );
    const text = this.#h('textarea', 'lsai-input lsai-instr-text');
    text.rows = 12;
    text.spellcheck = true;
    text.placeholder =
      'For example:\n- Answer in Russian, short and to the point.\n- I am a product manager; projects are pages tagged #project.\n' +
      '- Put summaries at the top of a page, as bullet points.\n- Ask before rewriting more than a few blocks.';
    const count = this.#h('span', 'lsai-hint');
    const builtIn = this.#h('details', 'lsai-instr-builtin');
    builtIn.appendChild(this.#h('summary', undefined, 'Built-in rules (always on, come first)'));
    const builtInText = this.#h('pre', 'lsai-card-pre');
    builtIn.appendChild(builtInText);
    const state = this.#h('span', 'lsai-hint');
    const close = this.#button('lsai-btn2', 'Close', 'Close (Esc)', () => done());
    const save = this.#button('lsai-send', 'Save', 'Save (⌘S or ⌘Enter)', () => void doSave());
    const actions = this.#h('div', 'lsai-actions');
    actions.append(state, close, save);
    const countRow = this.#h('div', 'lsai-instr-count');
    countRow.appendChild(count);
    root.append(title, help, text, countRow, actions, builtIn);

    let saved = '';
    let max = 8000;
    let loaded = false;
    let warnedDirty = false;
    const refresh = (): void => {
      const n = text.value.trim().length;
      count.textContent = `${n} / ${max}`;
      count.classList.toggle('lsai-bad', n > max);
      save.disabled = !loaded || n > max || text.value.trim() === saved;
    };
    const done = (force = false): void => {
      if (!force && loaded && text.value.trim() !== saved && !warnedDirty) {
        warnedDirty = true;
        state.textContent = 'Not saved. Close again to discard.';
        state.className = 'lsai-hint lsai-bad';
        return;
      }
      root.remove();
      this.#instr = null;
      this.#els.instrBtn.classList.remove('lsai-on');
      this.#els.log.hidden = false;
      this.#els.foot.hidden = false;
      this.#els.input.focus();
    };
    const doSave = async (): Promise<void> => {
      if (!b || save.disabled) return;
      save.disabled = true;
      state.className = 'lsai-hint';
      state.textContent = 'Saving…';
      try {
        const r = await b.saveInstructions(text.value);
        saved = r.text;
        text.value = r.text;
        warnedDirty = false;
        state.textContent = r.text === '' ? 'Cleared. The AI uses only the built-in rules.' : 'Saved. Used from your next message.';
        state.className = 'lsai-hint lsai-good';
      } catch (err) {
        state.textContent = `Not saved: ${(err as Error).message}`;
        state.className = 'lsai-hint lsai-bad';
      }
      refresh();
    };
    text.addEventListener('input', () => {
      warnedDirty = false;
      if (state.textContent?.startsWith('Not saved.')) state.textContent = '';
      refresh();
    });
    text.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'Enter')) {
        e.preventDefault();
        void doSave();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        done();
      }
    });

    this.#instr = { root, close: done };
    this.#els.instrBtn.classList.add('lsai-on');
    this.#els.log.hidden = true;
    this.#els.foot.hidden = true;
    this.#els.log.after(root);
    text.disabled = true;
    state.textContent = 'Loading…';
    refresh();
    if (!b) {
      state.textContent = 'Connect the bridge first (see the setup notes).';
      state.className = 'lsai-hint lsai-bad';
      return;
    }
    try {
      const r = await b.instructions();
      saved = r.text;
      max = r.maxChars;
      text.value = r.text;
      builtInText.textContent = r.builtIn;
      loaded = true;
      text.disabled = false;
      state.textContent = r.updatedAt ? `Last saved ${new Date(r.updatedAt).toLocaleString()}` : '';
      text.focus();
    } catch (err) {
      const old = err instanceof BridgeError && err.status === 404;
      state.textContent = old ? 'This bridge is too old for instructions: update it (bridge 0.7.0 or newer) and restart it.' : `Could not load: ${(err as Error).message}`;
      state.className = 'lsai-hint lsai-bad';
    }
    refresh();
  }

  // ---------- lifecycle ----------

  async start(): Promise<void> {
    const b = this.#d.bridge;
    if (!b) {
      this.#setup('Not set up yet', [
        'Start the bridge in Terminal:  node bin/logseq-ai-bridge.ts start',
        'Then copy its token:  node bin/logseq-ai-bridge.ts token',
        'Paste the token into Settings → Plugins → Logseq AI → Bridge token.',
      ]);
      return;
    }
    try {
      const h = await b.health();
      this.#bridgeVersion = h.version ?? '?';
      this.#conn({ state: 'live', mode: b.mode });
      this.#providers = await b.providers();
      this.#chats = await b.chats();
    } catch (err) {
      this.#connError(err);
      return;
    }
    this.#fillProviders();
    this.#fillChats();
    const saved = this.#d.prefs.get().chatId;
    await this.#selectChat(saved && this.#chats.some((c) => c.id === saved) ? saved : null);
  }

  destroy(): void {
    this.#destroyed = true;
    this.#unsub?.();
    this.#changes.clear();
  }

  focus(): void {
    this.#els.input.focus();
  }

  /** Called on route changes: the page chip follows the page you're viewing. */
  setCurrentPage(page: { uuid: string; title: string; kind: 'page' | 'block' } | null): void {
    this.#page = page;
    this.#renderChips();
  }

  /** Pins blocks (e.g. from the block menu) as context for the next messages. */
  pinBlocks(blocks: { uuid: string; title: string }[]): void {
    for (const b of blocks) this.#pinned.set(b.uuid, b.title);
    this.#renderChips();
  }

  // ---------- setup / errors ----------

  #setup(title: string, lines: string[]): void {
    this.#els.status.textContent = title;
    this.#els.status.className = 'lsai-status lsai-bad';
    const box = this.#h('div', 'lsai-setup');
    box.appendChild(this.#h('strong', undefined, title));
    for (const l of lines) box.appendChild(this.#h('div', 'lsai-mono', l));
    this.#els.log.replaceChildren(box);
  }

  #connError(err: unknown): void {
    const e = err instanceof BridgeError ? err : new BridgeError(0, String((err as Error)?.message ?? err));
    const origin = (() => {
      try {
        return globalThis.location.origin;
      } catch {
        return '?';
      }
    })();
    if (e.status === 401) {
      this.#setup('The bridge rejected the token', ['Run:  node bin/logseq-ai-bridge.ts token', 'and paste it into the plugin settings again.']);
    } else if (e.status === 403) {
      this.#setup('The bridge refused this connection', [
        e.message,
        `This plugin's origin is: ${origin}`,
        'If that is not in "allowedOrigins" in the bridge config.json, add it and restart the bridge.',
      ]);
    } else {
      this.#setup('Cannot reach the bridge', [e.message, 'Is it running?  node bin/logseq-ai-bridge.ts start']);
    }
  }

  #conn(s: ConnState): void {
    const el = this.#els.status;
    if (s.state === 'live') {
      el.textContent = `● Connected${s.mode === 'proxy' ? ' (via Logseq)' : ''} · panel ${PANEL_VERSION} · bridge ${this.#bridgeVersion}`;
      el.className = 'lsai-status lsai-good';
    } else if (s.state === 'retrying') {
      el.textContent = `○ Reconnecting… ${s.error ?? ''}`;
      el.className = 'lsai-status lsai-bad';
    } else {
      el.textContent = 'Connecting…';
      el.className = 'lsai-status';
    }
  }

  // ---------- pickers ----------

  #option(select: HTMLSelectElement, value: string, label: string): void {
    const o = this.#h('option', undefined, label);
    o.value = value;
    select.appendChild(o);
  }

  #fillProviders(): void {
    const { provider } = this.#els;
    provider.replaceChildren();
    for (const p of this.#providers) {
      // "Claude (Pro, claude CLI)" → "Claude · cloud"; the full label is the tooltip.
      this.#option(provider, p.id, `${p.label.replace(/\s*\([^)]*\)/g, '')} · ${p.locality}`);
      const o = provider.lastElementChild as HTMLOptionElement | null;
      if (o) o.title = p.label;
    }
    const pref = this.#d.prefs.get().provider;
    provider.value = this.#providers.some((p) => p.id === pref) ? (pref as string) : (this.#providers[0]?.id ?? '');
    this.#fillModels();
  }

  #fillModels(): void {
    const { provider, model } = this.#els;
    const p = this.#providers.find((x) => x.id === provider.value);
    model.replaceChildren();
    for (const m of p?.models ?? []) this.#option(model, m.id, m.label);
    const pref = this.#d.prefs.get().model;
    model.value = p?.models.some((m) => m.id === pref) ? (pref as string) : (p?.models[0]?.id ?? '');
    this.#fillEfforts();
  }

  #fillEfforts(): void {
    const { provider, model, effort } = this.#els;
    const m = this.#providers.find((x) => x.id === provider.value)?.models.find((x) => x.id === model.value);
    effort.replaceChildren();
    for (const e of m?.efforts ?? ['auto']) this.#option(effort, e, EFFORT_LABEL[e]);
    const pref = this.#d.prefs.get().effort;
    effort.value = m?.efforts.includes(pref as Effort) ? (pref as string) : (m?.efforts[0] ?? 'auto');
  }

  #fillChats(): void {
    const s = this.#els.chatSelect;
    s.replaceChildren();
    this.#option(s, '', 'New chat');
    for (const c of this.#chats) this.#option(s, c.id, c.title);
    s.value = this.#chatId ?? '';
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
        this.#renderChips();
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

  // ---------- chats ----------

  async #selectChat(id: string | null): Promise<void> {
    this.#unsub?.();
    this.#unsub = null;
    this.#live = null;
    this.#setBusy(false);
    this.#chatId = id;
    this.#d.prefs.set({ chatId: id ?? '' });
    this.#els.chatSelect.value = id ?? '';
    this.#els.log.replaceChildren();
    if (!id) {
      this.#els.log.appendChild(this.#h('div', 'lsai-empty', 'Ask anything about your notes. The page you are on is sent as context; #private blocks never leave your Mac.'));
      return;
    }
    await this.#loadChat(id);
  }

  async #loadChat(id: string): Promise<void> {
    const b = this.#d.bridge;
    if (!b) return;
    let state;
    try {
      state = await b.chat(id);
    } catch (err) {
      this.#connError(err);
      return;
    }
    if (this.#destroyed || this.#chatId !== id) return;
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
    this.#unsub = b.subscribe(id, state.lastSeq, (ev) => this.#onEvent(id, ev), (s) => this.#conn(s));
  }

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
    if (!b || !text || this.#busy) return;
    const { provider, model, effort } = this.#els;
    if (!provider.value || !model.value) return;
    this.#setBusy(true);
    try {
      if (!this.#chatId) {
        const chat = await b.createChat(text.slice(0, 60));
        this.#chats.unshift(chat);
        this.#chatId = chat.id;
        this.#d.prefs.set({ chatId: chat.id });
        this.#fillChats();
        this.#els.log.replaceChildren();
        this.#unsub = b.subscribe(chat.id, 0, (ev) => this.#onEvent(chat.id, ev), (s) => this.#conn(s));
      }
      const includePage = this.#d.prefs.get().includePage !== false;
      this.#els.log.appendChild(this.#h('div', 'lsai-msg lsai-user', text));
      this.#scroll(true);
      this.#els.input.value = '';
      await b.send(this.#chatId, {
        text,
        provider: provider.value,
        model: model.value,
        effort: effort.value as Effort,
        context: {
          ...(includePage && this.#page ? { pageUuid: this.#page.uuid } : {}),
          blockUuids: [...this.#pinned.keys()],
        },
      });
    } catch (err) {
      this.#setBusy(false);
      this.#els.input.value = text;
      this.#els.log.appendChild(this.#h('div', 'lsai-error', `Could not send: ${(err as Error).message}`));
      this.#scroll(true);
    }
  }

  async #stop(): Promise<void> {
    if (this.#chatId) await this.#d.bridge?.cancel(this.#chatId).catch(() => undefined);
  }

  #setBusy(busy: boolean): void {
    this.#busy = busy;
    this.#els.send.disabled = busy;
    this.#els.stop.hidden = !busy;
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
    const body = this.#h('div', 'lsai-body lsai-plain');
    const dots = this.#h('div', 'lsai-dots', '…');
    root.append(meta, steps, body, dots);
    this.#els.log.appendChild(root);
    this.#live = { turnId, root, body, steps, dots, text: '', stepRows: new Map() };
    return this.#live;
  }

  #onEvent(chatId: string, ev: BridgeEvent): void {
    if (this.#destroyed || chatId !== this.#chatId) return;
    if (ev.type === 'log.gap' || (this.#epoch !== null && ev.epoch && ev.epoch !== this.#epoch)) {
      // The bridge restarted or events were dropped: reload the transcript.
      this.#epoch = ev.epoch || null;
      void this.#selectChat(chatId);
      return;
    }
    this.#epoch = ev.epoch || this.#epoch;
    const near = this.#nearBottom();
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
        if (meta) meta.textContent = [ev.data.provider, ev.data.model, ev.data.locality === 'cloud' ? 'cloud' : 'local'].filter(Boolean).join(' · ');
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
        live.steps.appendChild(row);
        live.stepRows.set(String(ev.data.callId), row);
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
          const reason = String(ev.data.stopReason ?? 'end');
          if (reason !== 'end') live.root.appendChild(this.#h('div', 'lsai-meta', `(${reason})`));
        }
        this.#live = null;
        this.#setBusy(false);
        break;
      }
      default:
        break;
    }
    this.#scroll(near);
  }

  // ---------- approval cards ----------

  #nearBottom(): boolean {
    const l = this.#els.log;
    return l.scrollHeight - l.scrollTop - l.clientHeight < 80;
  }

  #scroll(force: boolean): void {
    if (force) this.#els.log.scrollTop = this.#els.log.scrollHeight;
  }
}

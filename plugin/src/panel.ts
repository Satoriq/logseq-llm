import { BridgeError } from './bridge';
import type { BridgeClient, ConnState } from './bridge';
import { ChangeCards } from './changes';
import { ChatView, shortLabel } from './chatview';
import type { ViewDeps } from './chatview';
import { activate, addTab, allTabs, clampRatio, closeTab, groupOf, groups, moveTab, newGroup, parseLayout, setRatio, zoneAt } from './layout';
import type { Group, LayoutNode, Split, Tab, Zone } from './layout';
import { PANEL_VERSION } from './version';
import type { AutoApprove, BridgeEvent, ChatMeta, ConsultTarget, EditorPort, Prefs, ProviderInfo, SettingsState } from './types';

/**
 * The panel's shell: the top bar, settings, your instructions, and the tabs and splits. Each tab
 * is a ChatView (chatview.ts). Built with createElement/textContent only (see render.ts for the
 * rules). It depends on nothing Logseq-specific except the EditorPort, so it can be tested in a
 * plain browser page.
 */

export type PanelDeps = {
  doc: Document;
  /** null when the bridge URL/token isn't configured yet. */
  bridge: BridgeClient | null;
  editor: EditorPort;
  prefs: { get: () => Prefs; set: (p: Partial<Prefs>) => void };
  onClose: () => void;
};

/** How long a finished card from a connected app stays in view. */
const APP_CARD_KEPT_MS = 8000;
/** A press on a tab turns into a drag after this many pixels. */
const DRAG_START_PX = 6;

type Drop = { groupId: string; zone: Zone; index?: number; rect: DOMRect };

function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export class Panel {
  readonly root: HTMLElement;
  #d: PanelDeps;
  #doc: Document;
  #els!: {
    status: HTMLElement;
    chatSelect: HTMLSelectElement;
    setup: HTMLElement;
    area: HTMLElement;
    apps: HTMLElement;
    instrBtn: HTMLButtonElement;
  };
  #providers: ProviderInfo[] = [];
  #bridgeVersion = '?';
  #chats: ChatMeta[] = [];
  #layout: LayoutNode | null = null;
  #views = new Map<string, ChatView>();
  /** The tab you were last in: new tabs and pinned blocks go there. */
  #focusTab: string | null = null;
  #strips = new Map<string, HTMLElement>();
  #savedLayout = '';
  #page: { uuid: string; title: string; kind: 'page' | 'block' } | null = null;
  /** Cards from connected apps, in their own place: they belong to no chat. */
  #appChanges: ChangeCards;
  /** Closes the open settings window, if any. */
  #closeSettings: (() => void) | null = null;
  /** The open instructions editor, if any. */
  #instr: { root: HTMLElement; close: (force?: boolean) => void } | null = null;

  constructor(root: HTMLElement, deps: PanelDeps) {
    this.root = root;
    this.#d = deps;
    this.#doc = deps.doc;
    this.#appChanges = new ChangeCards({
      doc: deps.doc,
      bridge: () => this.#d.bridge,
      onChange: () => {
        this.#els.apps.scrollTop = this.#els.apps.scrollHeight;
      },
      applyAllHint: 'Apply this and any further changes from this app, until it goes quiet for 2 minutes (10 minutes at most)',
    });
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
    chatSelect.title = 'Open a chat in a tab';
    chatSelect.addEventListener('change', () => {
      const id = chatSelect.value;
      chatSelect.value = '';
      if (id) void this.#openChat(id);
    });
    const instrBtn = this.#button('lsai-icon', '✎', 'Your instructions for the AI', () => void this.#toggleInstructions());
    row1.append(
      chatSelect,
      instrBtn,
      this.#button('lsai-icon', '⚙', 'Settings', () => void this.#openSettings()),
      this.#button('lsai-icon', '×', 'Close the panel', () => this.#d.onClose()),
    );
    const status = this.#h('div', 'lsai-status', 'Connecting…');
    head.append(row1, status);

    const setup = this.#h('div', 'lsai-setup-wrap');
    setup.hidden = true;
    const area = this.#h('div', 'lsai-area');
    const apps = this.#h('div', 'lsai-apps');

    // Typing in the panel must not trigger Logseq's keyboard shortcuts.
    for (const type of ['keydown', 'keyup', 'keypress'] as const) {
      this.root.addEventListener(type, (e) => e.stopPropagation());
    }

    this.root.append(head, setup, area, apps);
    this.#els = { status, chatSelect, setup, area, apps, instrBtn };
  }

  // ---------- settings ----------

  async #openSettings(): Promise<void> {
    if (this.#closeSettings) return;
    const opener = this.#doc.activeElement as HTMLElement | null;
    const wrap = this.#h('div', 'lsai-modal-wrap');
    const box = this.#h('div', 'lsai-modal');
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.setAttribute('aria-label', 'Settings');
    box.tabIndex = -1;
    const close = (): void => {
      wrap.remove();
      this.#closeSettings = null;
      opener?.focus();
    };
    const head = this.#h('div', 'lsai-modal-head');
    head.append(this.#h('strong', undefined, 'Settings'), this.#button('lsai-icon', '×', 'Close settings', close));
    const body = this.#h('div', 'lsai-modal-body', 'Loading…');
    box.append(head, body);
    wrap.appendChild(box);
    wrap.addEventListener('click', (e) => {
      if (e.target === wrap) close();
    });
    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    });
    this.#closeSettings = close;
    this.root.appendChild(wrap);
    box.focus();

    const b = this.#d.bridge;
    try {
      if (!b) throw new Error('The bridge is not set up yet.');
      const state = await b.settings();
      if (this.#closeSettings === close) this.#fillSettings(body, state);
    } catch (err) {
      body.textContent = `Could not load the settings: ${(err as Error).message}`;
    }
  }

  #fillSettings(body: HTMLElement, state: SettingsState): void {
    const b = this.#d.bridge;
    const message = this.#h('div', 'lsai-hint');
    const rows: { key: keyof AutoApprove; label: string; hint: string }[] = [
      { key: 'writes', label: 'Approve all writes', hint: 'New blocks, tasks and pages' },
      { key: 'edits', label: 'Approve all edits', hint: 'Changes to existing blocks' },
      { key: 'deletes', label: 'Approve all deletes', hint: 'Removing blocks' },
    ];
    let current = state.autoApprove;
    const boxes = new Map<keyof AutoApprove, HTMLInputElement>();
    const show = (): void => {
      for (const [key, input] of boxes) input.checked = current[key];
    };
    const save = async (): Promise<void> => {
      const next = { ...current };
      for (const [key, input] of boxes) {
        next[key] = input.checked;
        input.disabled = true;
      }
      message.className = 'lsai-hint';
      message.textContent = 'Saving…';
      try {
        current = (await (b as BridgeClient).saveAutoApprove(next)).autoApprove;
        message.textContent = 'Saved. Used from the next change.';
      } catch (err) {
        message.className = 'lsai-hint lsai-bad';
        message.textContent = `Not saved: ${(err as Error).message}`;
      }
      show();
      for (const input of boxes.values()) input.disabled = false;
    };

    const section = this.#h('div', 'lsai-setting');
    section.appendChild(this.#h('div', 'lsai-setting-title', 'Auto-approve'));
    section.appendChild(this.#h('div', 'lsai-hint', `Skip the card for these changes in ${state.graph ? `"${state.graph}"` : 'this graph'}.`));
    for (const row of rows) {
      const label = this.#h('label', 'lsai-check');
      const input = this.#h('input');
      input.type = 'checkbox';
      input.disabled = !state.writable;
      input.addEventListener('change', () => void save());
      boxes.set(row.key, input);
      const text = this.#h('span');
      text.append(this.#h('span', undefined, row.label), this.#h('span', 'lsai-hint', row.hint));
      label.append(input, text);
      section.appendChild(label);
    }
    section.appendChild(
      this.#h(
        'div',
        'lsai-hint',
        state.writable
          ? 'Also covers Claude Desktop and Codex. A change with a warning (web link, new page, hidden link) and any memory change still ask. Edits and deletes wait 2 seconds, so you can Abort.'
          : "The AI can't write to this graph, so these have no effect.",
      ),
    );
    section.appendChild(message);
    show();
    body.replaceChildren(section);
    if (state.consult !== undefined) body.appendChild(this.#consultSetting(state.consult));
  }

  /** The cloud model a local model may ask. */
  #consultSetting(saved: ConsultTarget | null): HTMLElement {
    const b = this.#d.bridge as BridgeClient;
    const section = this.#h('div', 'lsai-setting');
    section.appendChild(this.#h('div', 'lsai-setting-title', 'Consult a cloud model'));
    section.appendChild(this.#h('div', 'lsai-hint', 'A local model can ask this model one question. You read the exact text first, and nothing else is sent.'));
    const select = this.#h('select', 'lsai-select');
    select.title = 'Consult model';
    const targets = new Map<string, ConsultTarget | null>([['off', null]]);
    const add = (value: string, label: string): void => {
      const o = this.#h('option', undefined, label);
      o.value = value;
      select.appendChild(o);
    };
    add('off', 'Off');
    for (const p of this.#providers) {
      if (p.locality !== 'cloud' || !p.consult) continue;
      for (const m of p.models) {
        const value = `${p.id}/${m.id}`;
        targets.set(value, { provider: p.id, model: m.id });
        add(value, `${shortLabel(p)} · ${m.label}`);
      }
    }
    const value = (t: ConsultTarget | null): string => (t ? `${t.provider}/${t.model}` : 'off');
    let current = saved;
    select.value = value(current);
    const message = this.#h('div', 'lsai-hint');
    select.addEventListener('change', () => {
      void (async () => {
        select.disabled = true;
        message.className = 'lsai-hint';
        message.textContent = 'Saving…';
        try {
          current = (await b.saveConsult(targets.get(select.value) ?? null)).consult ?? null;
          message.textContent = 'Saved. Used from the next message.';
        } catch (err) {
          message.className = 'lsai-hint lsai-bad';
          message.textContent = `Not saved: ${(err as Error).message}`;
        }
        select.value = value(current);
        select.disabled = false;
      })();
    });
    section.append(select, message);
    return section;
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
    const memory = this.#h('div', 'lsai-instr-help');
    memory.hidden = true;
    const text = this.#h('textarea', 'lsai-input lsai-instr-text');
    text.rows = 12;
    text.spellcheck = true;
    text.placeholder =
      'For example:\n- Answer in Ukrainian, short and to the point.\n- I am a product manager; projects are pages tagged #project.\n' +
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
    root.append(title, help, memory, text, countRow, actions, builtIn);

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
      this.#els.area.hidden = false;
      this.focus();
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
    this.#els.area.hidden = true;
    this.#els.area.after(root);
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
      if (r.memoryPage) {
        const page = r.memoryPage;
        memory.append(
          this.#h('span', undefined, `Memory: Claude keeps what it learns about you on the page "${page}" (you approve each change). `),
          this.#button('lsai-linkbtn', 'Open it', `Open "${page}" in Logseq`, () => this.#d.editor.openPage(page)),
        );
        memory.hidden = false;
      }
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
    this.#fillChats();
    const prefs = this.#d.prefs.get();
    const known = new Set(this.#chats.map((c) => c.id));
    // Before tabs, the panel remembered one chat.
    const layout = (prefs.layout ? parseLayout(prefs.layout) : null) ?? newGroup(newId(), { id: newId(), chatId: prefs.chatId ?? null });
    for (const t of allTabs(layout)) if (t.chatId && !known.has(t.chatId)) t.chatId = null;
    this.#layout = layout;
    this.#focusTab = groups(layout)[0]?.active ?? null;
    this.#render();
  }

  destroy(): void {
    for (const v of this.#views.values()) v.destroy();
    this.#views.clear();
    this.#appChanges.clear();
    this.#closeSettings?.();
  }

  /** An approval event from a connected app (main.ts follows those, even with the panel closed). */
  appEvent(ev: BridgeEvent): void {
    this.#appChanges.onEvent(ev, () => this.#els.apps);
    // These cards belong to no chat, so a finished one leaves. One from the backlog goes at once.
    if (ev.type === 'approval.resolved') {
      const id = String(ev.data.id);
      setTimeout(() => this.#appChanges.drop(id), Date.now() - ev.ts > APP_CARD_KEPT_MS ? 0 : APP_CARD_KEPT_MS);
    }
  }

  focus(): void {
    this.#focused()?.focus();
  }

  /** Called on route changes: the page chip follows the page you're viewing. */
  setCurrentPage(page: { uuid: string; title: string; kind: 'page' | 'block' } | null): void {
    this.#page = page;
    for (const v of this.#views.values()) v.setPage(page);
  }

  /** Pins blocks (e.g. from the block menu) as context for the next messages, in the tab you're in. */
  pinBlocks(blocks: { uuid: string; title: string }[]): void {
    this.#focused()?.pin(blocks);
  }

  // ---------- setup / errors ----------

  #setup(title: string, lines: string[]): void {
    this.#els.status.textContent = title;
    this.#els.status.className = 'lsai-status lsai-bad';
    const box = this.#h('div', 'lsai-setup');
    box.appendChild(this.#h('strong', undefined, title));
    for (const l of lines) box.appendChild(this.#h('div', 'lsai-mono', l));
    this.#els.setup.replaceChildren(box);
    this.#els.setup.hidden = false;
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

  async #refreshVersion(): Promise<void> {
    const b = this.#d.bridge;
    const h = await b?.health().catch(() => null);
    if (!b || !h?.version) return;
    this.#bridgeVersion = h.version;
    this.#conn({ state: 'live', mode: b.mode });
  }

  #conn(s: ConnState): void {
    const el = this.#els.status;
    if (s.state === 'live') {
      this.#els.setup.hidden = true;
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

  #fillChats(): void {
    const s = this.#els.chatSelect;
    s.replaceChildren();
    const first = this.#h('option', undefined, 'Open a chat…');
    first.value = '';
    s.appendChild(first);
    for (const c of this.#chats) {
      const o = this.#h('option', undefined, c.title);
      o.value = c.id;
      s.appendChild(o);
    }
    s.value = '';
  }

  // ---------- tabs and splits ----------

  #focused(): ChatView | null {
    return this.#focusTab ? (this.#views.get(this.#focusTab) ?? null) : null;
  }

  #focusGroup(layout: LayoutNode): Group {
    return (this.#focusTab ? groupOf(layout, this.#focusTab) : null) ?? (groups(layout)[0] as Group);
  }

  #view(tab: Tab): ChatView {
    const existing = this.#views.get(tab.id);
    if (existing) return existing;
    const deps: ViewDeps = {
      doc: this.#doc,
      bridge: this.#d.bridge,
      editor: this.#d.editor,
      prefs: this.#d.prefs,
      providers: () => this.#providers,
      onChange: () => this.#changed(),
      onFocus: () => {
        this.#focusTab = tab.id;
      },
      onChatCreated: (chat) => {
        this.#chats.unshift(chat);
        this.#fillChats();
      },
      onConn: (s) => this.#conn(s),
      onError: (err) => this.#connError(err),
      onPrefs: () => {
        for (const v of this.#views.values()) v.refreshPrefs();
      },
      onBridgeRestart: () => void this.#refreshVersion(),
    };
    const view = new ChatView(tab, this.#chats.find((c) => c.id === tab.chatId)?.title ?? 'New chat', deps);
    view.setPage(this.#page);
    view.fillProviders();
    this.#views.set(tab.id, view);
    return view;
  }

  #strip(g: Group): HTMLElement {
    const strip = this.#h('div', 'lsai-tabs');
    strip.setAttribute('role', 'tablist');
    for (const t of g.tabs) {
      const v = this.#view(t);
      const el = this.#h('div', `lsai-tab${t.id === g.active ? ' lsai-on' : ''}${v.busy ? ' lsai-busy' : ''}${v.attention ? ' lsai-attn' : ''}`);
      el.dataset.tab = t.id;
      el.title = v.attention ? `${v.title} (waiting for your approval)` : v.title;
      el.tabIndex = 0;
      el.setAttribute('role', 'tab');
      el.setAttribute('aria-selected', String(t.id === g.active));
      el.append(this.#h('span', 'lsai-tab-label', v.title), this.#button('lsai-tab-close', '×', 'Close this tab', () => this.#closeTab(t.id)));
      el.addEventListener('pointerdown', (e) => this.#pressTab(e, t));
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target === el) this.#showTab(t.id);
      });
      strip.appendChild(el);
    }
    strip.appendChild(this.#button('lsai-tab-new', '＋', 'New chat in a new tab', () => this.#newTab(g.id)));
    return strip;
  }

  #nodeEl(n: LayoutNode, path = ''): HTMLElement {
    if (n.kind === 'split') {
      const el = this.#h('div', `lsai-split lsai-split-${n.dir}`);
      const a = this.#nodeEl(n.a, `${path}a`);
      const b = this.#nodeEl(n.b, `${path}b`);
      this.#share(a, b, n.ratio);
      const sash = this.#h('div', 'lsai-sash');
      sash.title = 'Drag to resize, double-click for half and half';
      sash.addEventListener('pointerdown', (e) => this.#pressSash(e, sash, el, a, b, n, path));
      sash.addEventListener('dblclick', () => {
        if (this.#layout) this.#commit(setRatio(this.#layout, path, 0.5));
      });
      el.append(a, sash, b);
      return el;
    }
    const el = this.#h('div', 'lsai-group');
    el.dataset.group = n.id;
    const strip = this.#strip(n);
    this.#strips.set(n.id, strip);
    const body = this.#h('div', 'lsai-group-body');
    for (const t of n.tabs) body.appendChild(this.#view(t).root);
    el.append(strip, body);
    return el;
  }

  #share(a: HTMLElement, b: HTMLElement, ratio: number): void {
    a.style.flex = `${ratio} 1 0`;
    b.style.flex = `${1 - ratio} 1 0`;
  }

  /** Follows the pointer on the elements themselves, so the chats aren't rebuilt while you drag. */
  #pressSash(e: PointerEvent, sash: HTMLElement, box: HTMLElement, a: HTMLElement, b: HTMLElement, split: Split, path: string): void {
    if (e.button !== 0) return;
    e.preventDefault();
    sash.setPointerCapture(e.pointerId);
    let ratio: number | null = null;
    const move = (ev: PointerEvent): void => {
      const r = box.getBoundingClientRect();
      ratio = clampRatio(split.dir === 'row' ? (ev.clientX - r.left) / r.width : (ev.clientY - r.top) / r.height);
      this.#share(a, b, ratio);
    };
    const up = (): void => {
      sash.removeEventListener('pointermove', move);
      sash.removeEventListener('pointerup', up);
      sash.removeEventListener('pointercancel', up);
      if (ratio === null || !this.#layout) return;
      this.#layout = setRatio(this.#layout, path, ratio);
      this.#save();
    };
    sash.addEventListener('pointermove', move);
    sash.addEventListener('pointerup', up);
    sash.addEventListener('pointercancel', up);
  }

  #render(): void {
    const layout = this.#layout;
    if (!layout) return;
    const views = [...this.#views.values()];
    const typing = views.find((v) => v.focused);
    for (const v of views) v.keepScroll();
    // First, so the tab rows drawn below show what being seen changed.
    for (const g of groups(layout)) for (const t of g.tabs) this.#view(t).setVisible(t.id === g.active);
    this.#strips.clear();
    this.#els.area.replaceChildren(this.#nodeEl(layout));
    for (const v of views) v.restoreScroll();
    typing?.focus();
  }

  #save(): void {
    const text = JSON.stringify(this.#layout);
    if (text === this.#savedLayout) return;
    this.#savedLayout = text;
    this.#d.prefs.set({ layout: text });
  }

  /** A tab's title, state or model changed: repaint the rows without touching the chats. */
  #changed(): void {
    const layout = this.#layout;
    if (!layout) return;
    for (const g of groups(layout)) {
      const old = this.#strips.get(g.id);
      if (!old) continue;
      const strip = this.#strip(g);
      old.replaceWith(strip);
      this.#strips.set(g.id, strip);
    }
    this.#save();
  }

  #commit(layout: LayoutNode): void {
    this.#layout = layout;
    this.#render();
    this.#save();
  }

  #showTab(id: string): void {
    if (!this.#layout) return;
    this.#focusTab = id;
    this.#commit(activate(this.#layout, id));
    this.#views.get(id)?.focus();
  }

  #newTab(groupId: string, chatId: string | null = null): void {
    if (!this.#layout) return;
    const tab: Tab = { id: newId(), chatId };
    this.#focusTab = tab.id;
    this.#commit(addTab(this.#layout, groupId, tab));
    this.#views.get(tab.id)?.focus();
  }

  async #openChat(id: string): Promise<void> {
    const layout = this.#layout;
    if (!layout) return;
    const open = allTabs(layout).find((t) => t.chatId === id);
    if (open) return this.#showTab(open.id);
    const g = this.#focusGroup(layout);
    const shown = this.#views.get(g.active);
    if (!shown?.unused) return this.#newTab(g.id, id);
    await shown.openChat(id, this.#chats.find((c) => c.id === id)?.title ?? 'Chat');
    this.#changed();
  }

  /** The chat stays in the list, and a reply still running carries on in the bridge. */
  #closeTab(id: string): void {
    if (!this.#layout) return;
    const next = closeTab(this.#layout, id);
    this.#views.get(id)?.destroy();
    this.#views.delete(id);
    const layout = next ?? newGroup(newId(), { id: newId(), chatId: null });
    if (this.#focusTab === id) this.#focusTab = this.#focusGroup(layout).active;
    this.#commit(layout);
  }

  // ---------- dragging a tab ----------

  /** Where a tab would land. Over a tab row it joins at that spot; over a chat, the part decides. */
  #dropAt(x: number, y: number, tabId: string): Drop | null {
    const el = this.#doc.elementFromPoint(x, y);
    const group = el?.closest<HTMLElement>('.lsai-group');
    const groupId = group?.dataset.group;
    const body = group?.querySelector('.lsai-group-body');
    if (!group || !groupId || !body) return null;
    const strip = el?.closest('.lsai-tabs');
    const rect = body.getBoundingClientRect();
    if (!strip) return { groupId, zone: zoneAt(rect, x, y), rect };
    const others = [...strip.querySelectorAll<HTMLElement>('.lsai-tab')].filter((t) => t.dataset.tab !== tabId);
    const index = others.filter((t) => {
      const r = t.getBoundingClientRect();
      return x > r.left + r.width / 2;
    }).length;
    return { groupId, zone: 'center', index, rect };
  }

  #markDrop(mark: HTMLElement, drop: Drop | null): void {
    mark.hidden = drop === null;
    if (!drop) return;
    const { width, height } = drop.rect;
    const base = this.root.getBoundingClientRect();
    const left = drop.rect.left - base.left + (drop.zone === 'right' ? width / 2 : 0);
    const top = drop.rect.top - base.top + (drop.zone === 'bottom' ? height / 2 : 0);
    const wide = drop.zone === 'left' || drop.zone === 'right' ? width / 2 : width;
    const tall = drop.zone === 'top' || drop.zone === 'bottom' ? height / 2 : height;
    mark.style.cssText = `left:${left}px;top:${top}px;width:${wide}px;height:${tall}px`;
  }

  /** A press that doesn't move is a click. Pointer events rather than HTML drag and drop, which Logseq uses for blocks. */
  #pressTab(e: PointerEvent, tab: Tab): void {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    const doc = this.#doc;
    const start = { x: e.clientX, y: e.clientY };
    const mark = this.#h('div', 'lsai-drop');
    let ghost: HTMLElement | null = null;
    let drop: Drop | null = null;
    const end = (): void => {
      doc.removeEventListener('pointermove', move);
      doc.removeEventListener('pointerup', up);
      doc.removeEventListener('pointercancel', end);
      doc.removeEventListener('keydown', escape, true);
      ghost?.remove();
      mark.remove();
      this.root.classList.remove('lsai-dragging');
    };
    const move = (ev: PointerEvent): void => {
      if (!ghost) {
        if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < DRAG_START_PX) return;
        ghost = this.#h('div', 'lsai-ghost', this.#views.get(tab.id)?.title ?? '');
        this.root.append(mark, ghost);
        this.root.classList.add('lsai-dragging');
      }
      // Inside the panel, so it stays readable next to the window's edge.
      const base = this.root.getBoundingClientRect();
      ghost.style.left = `${Math.max(0, Math.min(ev.clientX - base.left + 10, base.width - ghost.offsetWidth - 4))}px`;
      ghost.style.top = `${ev.clientY - base.top + 10}px`;
      drop = this.#dropAt(ev.clientX, ev.clientY, tab.id);
      this.#markDrop(mark, drop);
    };
    const up = (): void => {
      const dragged = ghost !== null;
      end();
      if (!dragged) return this.#showTab(tab.id);
      if (!drop || !this.#layout) return;
      this.#focusTab = tab.id;
      this.#commit(moveTab(this.#layout, tab.id, drop.groupId, drop.zone, newId(), drop.index));
    };
    const escape = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') end();
    };
    doc.addEventListener('pointermove', move);
    doc.addEventListener('pointerup', up);
    doc.addEventListener('pointercancel', end);
    doc.addEventListener('keydown', escape, true);
  }
}

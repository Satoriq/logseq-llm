import '@logseq/libs';
import type { BlockEntity, SettingSchemaDesc } from '@logseq/libs/dist/LSPlugin';
import { BridgeClient } from './bridge';
import type { HttpResult, ProxyRequest } from './bridge';
import { mountPanel } from './host';
import type { Mount } from './host';
import css from './panel.css';
import { Panel } from './panel';
import type { Prefs } from './panel';
import type { Effort, EditorPort, PanelSide } from './types';

/** Plugin entry: settings, toolbar button, commands, and the panel inside Logseq's DOM. */

const SIDES: PanelSide[] = ['right', 'left', 'top', 'bottom'];

const SETTINGS: SettingSchemaDesc[] = [
  {
    key: 'bridgeUrl',
    type: 'string',
    default: 'http://127.0.0.1:47615',
    title: 'Bridge URL',
    description: 'Where the local bridge listens. Only http://127.0.0.1:<port> is accepted.',
  },
  {
    key: 'bridgeToken',
    type: 'string',
    default: '',
    title: 'Bridge token',
    description: 'Paste the output of:  node bin/logseq-ai-bridge.ts token',
  },
  {
    key: 'panelSide',
    type: 'enum',
    enumChoices: SIDES,
    enumPicker: 'select',
    default: 'right',
    title: 'Panel side',
    description: 'Right and left sit next to the page (the page gets narrower). Top and bottom float over the page.',
  },
  {
    key: 'panelSize',
    type: 'number',
    default: 420,
    title: 'Panel size (px)',
    description: 'Width for right/left, height for top/bottom. You can also drag the panel edge.',
  },
];

type Settings = {
  bridgeUrl?: string;
  bridgeToken?: string;
  panelSide?: string;
  panelSize?: number;
  panelOpen?: boolean;
  prefProvider?: string;
  prefModel?: string;
  prefEffort?: string;
  prefChatId?: string;
  prefIncludePage?: boolean;
};

const CONNECTION_KEYS = ['bridgeUrl', 'bridgeToken'] as const;

function settings(): Settings {
  return (logseq.settings ?? {}) as Settings;
}

function side(): PanelSide {
  const s = settings().panelSide;
  return SIDES.includes(s as PanelSide) ? (s as PanelSide) : 'right';
}

function size(): number {
  const n = Number(settings().panelSize);
  return Number.isFinite(n) && n >= 260 && n <= 2000 ? Math.round(n) : 420;
}

/** The token only ever goes to 127.0.0.1. */
function bridgeClient(): BridgeClient | null {
  const s = settings();
  const url = (s.bridgeUrl ?? '').trim();
  const token = (s.bridgeToken ?? '').trim();
  if (!/^http:\/\/127\.0\.0\.1:\d{2,5}\/?$/.test(url) || token === '') return null;
  const proxy: ProxyRequest = async (o) => {
    try {
      const r = await logseq.Net.request<string>({
        url: o.url,
        method: o.method as 'GET' | 'POST',
        headers: o.headers,
        ...(o.body !== undefined ? { body: o.body } : {}),
        responseType: 'text',
        timeout: o.timeoutMs,
      });
      return { status: r.status, json: parse(await r.text()) } satisfies HttpResult;
    } catch (err) {
      const resp = (err as { response?: { status: number; text: () => Promise<string> } }).response;
      if (resp) return { status: resp.status, json: parse(await resp.text().catch(() => '')) };
      throw err;
    }
  };
  return new BridgeClient({ baseUrl: url, token, proxy });
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function blockTitle(b: BlockEntity | null | undefined): string {
  const anyB = b as (BlockEntity & { title?: string }) | null | undefined;
  return String(anyB?.title ?? anyB?.content ?? '').split('\n')[0] ?? '';
}

const editor: EditorPort = {
  openPage: (title) => logseq.App.pushState('page', { name: title }),
  openBlock: (uuid) => logseq.App.pushState('page', { name: uuid }),
  openExternal: (url) => void logseq.App.openExternalLink(url),
  currentPage: async () => {
    const p = (await logseq.Editor.getCurrentPage()) as (Record<string, unknown> & { uuid?: string }) | null;
    if (!p?.uuid) return null;
    // getCurrentPage returns a block when you've zoomed into one.
    const kind = p.page ? 'block' : 'page';
    const title = kind === 'block' ? blockTitle(p as unknown as BlockEntity) : String(p.title ?? p.originalName ?? p.name ?? '');
    return { uuid: String(p.uuid), title, kind };
  },
};

export async function main(): Promise<void> {
  logseq.useSettingsSchema(SETTINGS);
  const doc = parent.document; // Logseq's page (the plugin iframe itself stays hidden)
  logseq.provideStyle({ key: 'lsai-panel', style: css });

  let mount: Mount | null = null;
  let panel: Panel | null = null;

  const prefs = {
    get: (): Prefs => {
      const s = settings();
      return {
        ...(s.prefProvider ? { provider: s.prefProvider } : {}),
        ...(s.prefModel ? { model: s.prefModel } : {}),
        ...(s.prefEffort ? { effort: s.prefEffort as Effort } : {}),
        ...(s.prefChatId ? { chatId: s.prefChatId } : {}),
        includePage: s.prefIncludePage !== false,
      };
    },
    set: (p: Partial<Prefs>): void => {
      const patch: Settings = {};
      if (p.provider !== undefined) patch.prefProvider = p.provider;
      if (p.model !== undefined) patch.prefModel = p.model;
      if (p.effort !== undefined) patch.prefEffort = p.effort;
      if (p.chatId !== undefined) patch.prefChatId = p.chatId;
      if (p.includePage !== undefined) patch.prefIncludePage = p.includePage;
      logseq.updateSettings(patch);
    },
  };

  const open = async (): Promise<Panel> => {
    if (!mount) {
      mount = mountPanel(doc, { side: side(), size: size(), onResize: (n) => logseq.updateSettings({ panelSize: n }) });
    }
    mount.setVisible(true);
    if (!panel) {
      panel = new Panel(mount.root, { doc, bridge: bridgeClient(), editor, prefs, onClose: () => close() });
      panel.setCurrentPage(await editor.currentPage().catch(() => null));
      void panel.start();
    }
    logseq.updateSettings({ panelOpen: true });
    return panel;
  };

  const close = (): void => {
    mount?.setVisible(false);
    logseq.updateSettings({ panelOpen: false });
  };

  const rebuild = async (): Promise<void> => {
    const wasOpen = mount !== null && settings().panelOpen !== false;
    panel?.destroy();
    mount?.destroy();
    panel = null;
    mount = null;
    if (wasOpen) await open();
  };

  const toggle = async (): Promise<void> => {
    if (mount && !mount.root.classList.contains('lsai-hidden')) close();
    else (await open()).focus();
  };

  const pin = async (blocks: { uuid: string; title: string }[]): Promise<void> => {
    const p = await open();
    p.pinBlocks(blocks);
    p.focus();
  };

  logseq.provideModel({ lsaiToggle: () => void toggle() });
  logseq.App.registerUIItem('toolbar', {
    key: 'lsai-toggle',
    template: '<a class="button" data-on-click="lsaiToggle" title="Logseq AI"><span style="font-weight:700;font-size:12px;letter-spacing:.5px">AI</span></a>',
  });
  logseq.App.registerCommandPalette({ key: 'lsai-toggle', label: 'Logseq AI: Toggle panel', keybinding: { binding: 'mod+alt+a' } }, () => void toggle());
  logseq.App.registerCommandPalette({ key: 'lsai-ask-selection', label: 'Logseq AI: Ask about the selected blocks' }, async () => {
    const blocks = (await logseq.Editor.getSelectedBlocks()) ?? [];
    await pin(blocks.map((b) => ({ uuid: b.uuid, title: blockTitle(b) })));
  });
  logseq.Editor.registerBlockContextMenuItem('Ask Logseq AI about this block', async ({ uuid }) => {
    const b = await logseq.Editor.getBlock(uuid);
    await pin([{ uuid, title: blockTitle(b) }]);
  });
  logseq.Editor.registerSlashCommand('Ask Logseq AI', async ({ uuid }) => {
    const b = await logseq.Editor.getBlock(uuid);
    await logseq.Editor.exitEditingMode();
    await pin([{ uuid, title: blockTitle(b) }]);
  });

  logseq.App.onRouteChanged(async () => {
    panel?.setCurrentPage(await editor.currentPage().catch(() => null));
  });
  logseq.onSettingsChanged((next: Settings, prev: Settings) => {
    // A new URL/token needs a new connection; side/size only move the panel (no chat reload).
    if (CONNECTION_KEYS.some((k) => next?.[k] !== prev?.[k])) void rebuild();
    else if (next?.panelSide !== prev?.panelSide || next?.panelSize !== prev?.panelSize) mount?.setSide(side(), size());
  });
  logseq.beforeunload(async () => {
    panel?.destroy();
    mount?.destroy();
    logseq.provideStyle({ key: 'lsai-panel', style: '' });
  });

  if (settings().panelOpen) await open();
  console.info('[logseq-ai] ready; plugin origin =', globalThis.location.origin);
}

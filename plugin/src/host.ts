import type { PanelSide } from './types';

/**
 * Puts the panel into Logseq's own DOM (like logseq-panes-mode does) and keeps it there.
 * All host selectors live in this file, so a Logseq update needs one place fixed.
 *
 * Layout (from Logseq 2.0.2's DOM):
 *   main#app-container-wrapper > div#app-container (flex row)
 *     ├─ div#left-container   (the page)
 *     ├─ div#right-sidebar    (Logseq's own sidebar)
 *     └─ div#lsai-panel       ← ours, appended last; `order:-1` moves it to the left
 * Top/bottom: the panel floats over the page at full width (fixed position).
 */

export const SELECTORS = {
  container: '#app-container',
} as const;

export const PANEL_ID = 'lsai-panel';

export type Mount = {
  root: HTMLElement;
  setSide: (side: PanelSide, size: number) => void;
  setVisible: (visible: boolean) => void;
  destroy: () => void;
};

export function mountPanel(doc: Document, opts: { side: PanelSide; size: number; onResize: (size: number) => void }): Mount {
  doc.getElementById(PANEL_ID)?.remove(); // stale copy from a previous plugin load
  const root = doc.createElement('div');
  root.id = PANEL_ID;
  root.setAttribute('role', 'complementary');
  root.setAttribute('aria-label', 'Logseq AI');

  let side = opts.side;
  let size = opts.size;
  let visible = true;

  const handle = doc.createElement('div');
  handle.className = 'lsai-resize';
  handle.title = 'Drag to resize';
  root.appendChild(handle);

  const place = (): void => {
    const container = doc.querySelector(SELECTORS.container);
    if (side === 'left' || side === 'right') {
      if (container && root.parentElement !== container) container.appendChild(root);
      if (!container && root.parentElement !== doc.body) doc.body.appendChild(root);
    } else if (root.parentElement !== doc.body) {
      doc.body.appendChild(root);
    }
  };

  const html = doc.documentElement;
  const apply = (): void => {
    root.className = `lsai-side-${side}${visible ? '' : ' lsai-hidden'}`;
    root.style.setProperty('--lsai-size', `${size}px`);
    // Lets our CSS move Logseq's bottom-right help button out from under the panel.
    html.classList.toggle('lsai-open-right', visible && side === 'right');
    html.style.setProperty('--lsai-panel-size', `${size}px`);
    place();
  };

  // Re-attach if a Logseq re-render drops the panel. Checks are batched per frame.
  let scheduled = false;
  const win = doc.defaultView ?? window;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    win.requestAnimationFrame(() => {
      scheduled = false;
      if (!root.isConnected || ((side === 'left' || side === 'right') && root.parentElement !== doc.querySelector(SELECTORS.container))) place();
    });
  });
  observer.observe(doc.body, { childList: true, subtree: true });

  // Drag-to-resize on the inner edge.
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    const start = { x: e.clientX, y: e.clientY, size };
    const move = (ev: PointerEvent): void => {
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      const delta = side === 'right' ? -dx : side === 'left' ? dx : side === 'top' ? dy : -dy;
      const max = side === 'left' || side === 'right' ? win.innerWidth * 0.8 : win.innerHeight * 0.85;
      size = Math.round(Math.max(260, Math.min(max, start.size + delta)));
      root.style.setProperty('--lsai-size', `${size}px`);
      html.style.setProperty('--lsai-panel-size', `${size}px`);
    };
    const up = (): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      opts.onResize(size);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
  });

  apply();
  return {
    root,
    setSide: (s, z) => {
      side = s;
      size = z;
      apply();
    },
    setVisible: (v) => {
      visible = v;
      apply();
    },
    destroy: () => {
      observer.disconnect();
      root.remove();
      html.classList.remove('lsai-open-right');
      html.style.removeProperty('--lsai-panel-size');
    },
  };
}

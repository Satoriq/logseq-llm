import type { EditorPort } from './types';

/**
 * Safe Markdown renderer for model output.
 *
 * Hard rules (the panel runs with Logseq's own page privileges):
 * - Text only ever goes into text nodes. No innerHTML / outerHTML / insertAdjacentHTML.
 * - No <img>, <iframe>, <video>, <audio>, <link>, <script> or <style> is created, ever.
 *   Image Markdown becomes the text "[image: alt]", so a model can't make the app fetch
 *   a URL that carries your notes in it.
 * - Links are chips that show their full URL and open only on click, in the system browser.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Ctx = { doc: Document; editor: EditorPort };

function el<K extends keyof HTMLElementTagNameMap>(ctx: Ctx, tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = ctx.doc.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function chip(ctx: Ctx, label: string, title: string, onClick: () => void): HTMLElement {
  const b = el(ctx, 'button', 'lsai-chip', label);
  b.type = 'button';
  b.title = title;
  b.addEventListener('click', (e) => {
    e.preventDefault();
    onClick();
  });
  return b;
}

function safeHttpUrl(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

/** Inline Markdown: `code`, **bold**, *italic*, [[refs]], [text](url), ![img](url), bare URLs. */
export function renderInline(ctx: Ctx, text: string, into: Node): void {
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*|_[^_\s][^_\n]*_)|(!\[[^\]\n]*\]\([^)\s]*\))|(\[\[[^\]\n]{1,300}\]\])|(\(\([0-9a-f-]{36}\)\))|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+)/gi;
  let last = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) into.appendChild(ctx.doc.createTextNode(text.slice(last, i)));
    const s = m[0];
    if (m[1]) {
      into.appendChild(el(ctx, 'code', 'lsai-code', s.slice(1, -1)));
    } else if (m[2]) {
      const b = el(ctx, 'strong');
      renderInline(ctx, s.slice(2, -2), b);
      into.appendChild(b);
    } else if (m[3]) {
      const it = el(ctx, 'em');
      renderInline(ctx, s.slice(1, -1), it);
      into.appendChild(it);
    } else if (m[4]) {
      const alt = /^!\[([^\]]*)\]/.exec(s)?.[1] ?? '';
      into.appendChild(el(ctx, 'span', 'lsai-muted', `[image: ${alt || 'no description'}]`));
    } else if (m[5] || m[6]) {
      const inner = m[5] ? s.slice(2, -2) : s.slice(2, -2);
      if (UUID_RE.test(inner)) {
        into.appendChild(chip(ctx, '↗ block', `Open block ${inner}`, () => ctx.editor.openBlock(inner.toLowerCase())));
      } else {
        into.appendChild(chip(ctx, inner, `Open page "${inner}"`, () => ctx.editor.openPage(inner)));
      }
    } else if (m[7]) {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(s);
      const url = lm?.[2] ? safeHttpUrl(lm[2]) : null;
      const label = lm?.[1] ?? s;
      if (url) {
        into.appendChild(chip(ctx, `${label} ↗`, url, () => ctx.editor.openExternal(url)));
        into.appendChild(el(ctx, 'span', 'lsai-url', ` (${url})`));
      } else {
        into.appendChild(ctx.doc.createTextNode(s));
      }
    } else if (m[8]) {
      const trimmed = s.replace(/[.,;:!?]+$/, '');
      const url = safeHttpUrl(trimmed);
      if (url) into.appendChild(chip(ctx, trimmed, `Open ${url} in your browser`, () => ctx.editor.openExternal(url)));
      else into.appendChild(ctx.doc.createTextNode(trimmed));
      if (trimmed.length < s.length) into.appendChild(ctx.doc.createTextNode(s.slice(trimmed.length)));
    }
    last = i + s.length;
  }
  if (last < text.length) into.appendChild(ctx.doc.createTextNode(text.slice(last)));
}

/** Block Markdown: paragraphs, headings, lists, quotes, fenced code. */
export function renderMarkdown(ctx: Ctx, md: string): DocumentFragment {
  const frag = ctx.doc.createDocumentFragment();
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  let para: string[] = [];
  const flush = (): void => {
    if (para.length === 0) return;
    const p = el(ctx, 'p');
    para.forEach((l, k) => {
      if (k > 0) p.appendChild(el(ctx, 'br'));
      renderInline(ctx, l, p);
    });
    frag.appendChild(p);
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const fence = /^\s*```/.exec(line);
    if (fence) {
      flush();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```/.test(lines[i] ?? '')) body.push(lines[i++] ?? '');
      i += 1;
      const pre = el(ctx, 'pre', 'lsai-pre');
      pre.appendChild(el(ctx, 'code', undefined, body.join('\n')));
      frag.appendChild(pre);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      const level = Math.min(6, (h[1] ?? '#').length + 2) as 3 | 4 | 5 | 6;
      const head = el(ctx, `h${level}` as 'h3', 'lsai-h');
      renderInline(ctx, h[2] ?? '', head);
      frag.appendChild(head);
      i += 1;
      continue;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const ordered = /\d/.test(li[2] ?? '');
      const list = el(ctx, ordered ? 'ol' : 'ul', 'lsai-list');
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i] ?? '');
        if (!m) break;
        const item = el(ctx, 'li');
        const depth = Math.floor((m[1] ?? '').replace(/\t/g, '  ').length / 2);
        if (depth > 0) item.style.marginLeft = `${Math.min(depth, 6) * 1.1}em`;
        renderInline(ctx, m[3] ?? '', item);
        list.appendChild(item);
        i += 1;
      }
      frag.appendChild(list);
      continue;
    }
    const q = /^>\s?(.*)$/.exec(line);
    if (q) {
      flush();
      const bq = el(ctx, 'blockquote', 'lsai-quote');
      while (i < lines.length && /^>\s?/.test(lines[i] ?? '')) {
        const p = el(ctx, 'div');
        renderInline(ctx, (lines[i] ?? '').replace(/^>\s?/, ''), p);
        bq.appendChild(p);
        i += 1;
      }
      frag.appendChild(bq);
      continue;
    }
    if (line.trim() === '') {
      flush();
      i += 1;
      continue;
    }
    para.push(line);
    i += 1;
  }
  flush();
  return frag;
}

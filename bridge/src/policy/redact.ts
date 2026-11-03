import type { Ref } from '../graph/entity.ts';

export const HIDDEN_MARK = '[hidden]';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Replaces references to hidden entities inside a block's text:
 *   [[Title]]  #[[Title]]  #Title  [[uuid]]  ((uuid))
 * Matching is case-insensitive for titles. Only refs listed on the block are touched.
 */
export function redactRefs(text: string, hiddenRefs: readonly Ref[]): { text: string; count: number } {
  let out = text;
  let count = 0;
  const replace = (re: RegExp): void => {
    out = out.replace(re, () => {
      count += 1;
      return HIDDEN_MARK;
    });
  };
  for (const r of hiddenRefs) {
    if (r.uuid) {
      const u = escapeRegExp(r.uuid);
      replace(new RegExp(`\\[\\[${u}\\]\\]`, 'gi'));
      replace(new RegExp(`\\(\\(${u}\\)\\)`, 'gi'));
    }
    if (r.title !== '') {
      const t = escapeRegExp(r.title);
      replace(new RegExp(`#?\\[\\[${t}\\]\\]`, 'gi'));
      if (!/\s/.test(r.title)) replace(new RegExp(`#${t}(?![\\w/-])`, 'gi'));
    }
  }
  return { text: out, count };
}

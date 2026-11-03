import type { PropertyInfo } from '../graph/entity.ts';
import { ToolInputError } from './registry.ts';

/**
 * Shared rules for property names, types and values (read and write tools).
 *
 * The AI may set your own properties (user.property/...) of the everyday types, plus a few
 * of Logseq's built-in ones. Plugin properties belong to their plugin; the privacy
 * properties (ai-access and any your rules use) belong to you.
 */

/** Types the AI can give values to. */
export const SETTABLE_TYPES: ReadonlySet<string> = new Set(['default', 'number', 'checkbox', 'date', 'datetime', 'url', 'node']);

/** Built-in properties the AI may change. Everything else built-in is read-only for it. */
export const EDITABLE_BUILT_INS: ReadonlySet<string> = new Set([
  'logseq.property/status',
  'logseq.property/priority',
  'logseq.property/deadline',
  'logseq.property/scheduled',
  'logseq.property/description',
]);

export function canSet(info: PropertyInfo): boolean {
  if (info.type === null || !SETTABLE_TYPES.has(info.type)) return false;
  if (info.builtIn) return EDITABLE_BUILT_INS.has(info.ident);
  return info.ident.startsWith('user.property/');
}

/** How a type is described to the model (also the value format it should send). */
export function typeLabel(info: PropertyInfo): string {
  let t: string;
  if (info.choices.length > 0) t = `one of: ${info.choices.map((c) => c.title).join(', ')}`;
  else {
    switch (info.type) {
      case 'default': t = 'text'; break;
      case 'number': t = 'number'; break;
      case 'checkbox': t = 'true/false'; break;
      case 'date': t = 'date YYYY-MM-DD (an existing journal day)'; break;
      case 'datetime': t = 'date and time YYYY-MM-DD or YYYY-MM-DD HH:mm'; break;
      case 'url': t = 'web address'; break;
      case 'node': t = 'link to a page ([[Title]]) or block ((uuid))'; break;
      case 'page': t = 'page link'; break;
      case 'class': t = 'tag'; break;
      case 'property': t = 'property'; break;
      case 'asset': t = 'file'; break;
      default: t = info.type ?? 'unknown';
    }
  }
  return info.many ? `${t}; several values` : t;
}

/**
 * Finds a property by name (case-insensitive title) or exact ident. When your property and a
 * built-in one share a title, yours wins. Two of yours with the same title: ask for the ident.
 */
export function resolveProperty(props: ReadonlyMap<string, PropertyInfo>, name: string): PropertyInfo | null {
  const n = name.trim().replace(/::$/, '').trim();
  const exact = props.get(n);
  if (exact) return exact;
  const lower = n.toLowerCase();
  const all = [...props.values()].filter((p) => p.title.toLowerCase() === lower);
  const mine = all.filter((p) => !p.builtIn);
  if (mine.length > 1) {
    throw new ToolInputError(`several properties are called "${n}": use one of ${mine.map((p) => p.ident).join(', ')}`);
  }
  return mine[0] ?? all[0] ?? null;
}

/** "2026-11-05" → 20261105, or null if it isn't a real date. */
export function parseDay(s: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return y * 10000 + mo * 100 + d;
}

/** "2026-11-05" or "2026-11-05 14:30" (or with "T") → ms in local time, or null. */
export function parseDateTime(s: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/.exec(s.trim());
  if (!m) return null;
  const day = parseDay(m[1] as string);
  if (day === null) return null;
  const h = m[2] === undefined ? 0 : Number(m[2]);
  const min = m[3] === undefined ? 0 : Number(m[3]);
  if (h > 23 || min > 59) return null;
  return new Date(Math.floor(day / 10000), (Math.floor(day / 100) % 100) - 1, day % 100, h, min).getTime();
}

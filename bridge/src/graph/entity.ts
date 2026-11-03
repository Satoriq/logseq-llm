/**
 * Normalized graph entities, built from the CLI's `query` JSON
 * (`{"status":"ok","data":{"result":[[{...}], ...]}}`, keys like "block/title", "db/id").
 */

export type TagRef = { id: number; title: string; ident: string | null };
export type Ref = { id: number; title: string; uuid: string | null; isPage: boolean };

export type GNode = {
  id: number;
  uuid: string | null;
  title: string;
  /** Lower-cased page name; only pages have one. */
  name: string | null;
  /** Set for tags, properties and built-in entities (e.g. "user.class/private-ZzQXdUJm"). */
  ident: string | null;
  pageId: number | null;
  parentId: number | null;
  order: string;
  journalDay: number | null;
  /** Task status title (e.g. "Todo"), when the block is a task. */
  status: string | null;
  tags: TagRef[];
  refs: Ref[];
  /**
   * For the privacy rules: lower-cased property title → raw value texts (value-block text,
   * page/journal title, number, "true"/"false"). Covers user and public built-in properties.
   */
  props: Map<string, string[]>;
  /** The same properties with types and link targets, for display and edits (graph order). */
  properties: PropEntry[];
  /** Milliseconds since 1970 (block/created-at, block/updated-at). */
  createdAt: number | null;
  updatedAt: number | null;
  /** Set for the hidden value blocks Logseq creates for text properties. */
  createdFromProperty: number | null;
  /** From a recursive parent pull: the parent chain, nearest first (the page is last). */
  parent: GNode | null;
};

export type PropertyInfo = {
  id: number;
  ident: string;
  title: string;
  /** "default", "number", "checkbox", "date", "datetime", "url", "node", ... (null if unknown). */
  type: string | null;
  /** Cardinality many: the value is a set. */
  many: boolean;
  /** Logseq's own property (logseq.property/..., block/alias), not one the user made. */
  builtIn: boolean;
  /** Fixed choices ("closed values"), in their order. Empty when any value is allowed. */
  choices: { id: number; title: string }[];
};

export type PropValue = {
  /** What the user sees: the text, number, true/false, date, or the linked page's title. */
  text: string;
  /** What the privacy rules compare (titles, as before; dates as the journal page title). */
  raw: string;
  /** A page/block/journal this value links to (checked against the privacy rules before showing). */
  target: Ref | null;
  /** Links inside a text value (redacted like links in block text). */
  refs: Ref[];
};

export type PropEntry = { info: PropertyInfo; values: PropValue[] };

/** Types whose values are stored inline, not as references to other entities. */
export const INLINE_PROPERTY_TYPES: ReadonlySet<string> = new Set(['checkbox', 'datetime', 'string', 'raw-number', 'keyword', 'map', 'coll', 'any', 'json']);

function obj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isInteger(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

function idOf(v: unknown): number | null {
  const o = obj(v);
  return o ? num(o['db/id']) : num(v);
}

/** Flattens `data.result` rows (each a 1-tuple of a pulled map) into a list of maps. */
export function resultRows(json: unknown): Record<string, unknown>[] {
  const data = obj(obj(json)?.data);
  const result = data?.result;
  if (!Array.isArray(result)) return [];
  const out: Record<string, unknown>[] = [];
  for (const row of result) {
    const cell = Array.isArray(row) ? row[0] : row;
    const o = obj(cell);
    if (o) out.push(o);
  }
  return out;
}

/** Items of a list/search command (`data.items`). */
export function resultItems(json: unknown): Record<string, unknown>[] {
  const items = obj(obj(json)?.data)?.items;
  return Array.isArray(items) ? items.map(obj).filter((x): x is Record<string, unknown> => x !== null) : [];
}

function refOf(o: Record<string, unknown>): Ref | null {
  const id = num(o['db/id']);
  if (id === null) return null;
  return { id, title: str(o['block/title']) ?? '', uuid: str(o['block/uuid']), isPage: str(o['block/name']) !== null || str(o['db/ident']) !== null };
}

function refsOf(v: unknown): Ref[] {
  const out: Ref[] = [];
  for (const r of Array.isArray(v) ? v : []) {
    const o = obj(r);
    const ref = o ? refOf(o) : null;
    if (ref) out.push(ref);
  }
  return out;
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

/** 20261105 → "2026-11-05". */
export function formatJournalDay(day: number): string {
  return `${Math.floor(day / 10000)}-${pad(Math.floor(day / 100) % 100)}-${pad(day % 100)}`;
}

/** Local time "2026-11-05 14:30", or just the date at midnight. */
export function formatDateTime(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(ms);
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return d.getHours() === 0 && d.getMinutes() === 0 ? date : `${date} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function inlineText(v: unknown, type: string | null): string | null {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return type === 'datetime' ? formatDateTime(v) : String(v);
  if (typeof v === 'string') return v;
  if (v !== null && typeof v === 'object') {
    const j = JSON.stringify(v);
    return j.length > 300 ? `${j.slice(0, 300)}…` : j;
  }
  return null;
}

/**
 * One pulled property value. A value entity Logseq made for this property (text, number, url,
 * or one of its fixed choices) is shown as its content; anything else is a link to a real
 * page/block/journal and keeps its target, so the privacy filter can check it.
 */
function propValue(v: unknown, info: PropertyInfo): PropValue | null {
  const o = obj(v);
  if (!o) {
    const t = inlineText(v, info.type);
    return t === null ? null : { text: t, raw: t, target: null, refs: [] };
  }
  const id = num(o['db/id']);
  if (id === null) return null;
  const title = str(o['block/title']);
  const own = o['logseq.property/created-from-property'] !== undefined || o['block/closed-value-property'] !== undefined;
  if (own || info.choices.some((c) => c.id === id)) {
    const value = o['logseq.property/value'];
    const text = title ?? (value !== undefined ? inlineText(value, info.type) : null) ?? '';
    return { text, raw: text, target: null, refs: refsOf(o['block/refs']) };
  }
  const target = refOf(o) as Ref;
  const day = num(o['block/journal-day']);
  const text = day !== null ? formatJournalDay(day) : title ?? '';
  return { text, raw: title ?? text, target, refs: [] };
}

/**
 * Turns a pulled map into a GNode. `props` maps property idents to their info;
 * attributes of unknown properties are ignored (and can't match rules).
 */
export function toNode(raw: Record<string, unknown>, props: ReadonlyMap<string, PropertyInfo>): GNode | null {
  const id = num(raw['db/id']);
  if (id === null) return null;
  const tags: TagRef[] = [];
  for (const t of Array.isArray(raw['block/tags']) ? raw['block/tags'] : []) {
    const o = obj(t);
    const tid = o ? num(o['db/id']) : null;
    if (o && tid !== null) tags.push({ id: tid, title: str(o['block/title']) ?? '', ident: str(o['db/ident']) });
  }
  const refs: Ref[] = [];
  for (const r of Array.isArray(raw['block/refs']) ? raw['block/refs'] : []) {
    const o = obj(r);
    const rid = o ? num(o['db/id']) : null;
    if (o && rid !== null) {
      refs.push({ id: rid, title: str(o['block/title']) ?? '', uuid: str(o['block/uuid']), isPage: str(o['block/name']) !== null });
    }
  }
  const propValues = new Map<string, string[]>();
  const properties: PropEntry[] = [];
  for (const [key, value] of Object.entries(raw)) {
    const info = props.get(key);
    if (!info) continue;
    const values: PropValue[] = [];
    for (const v of Array.isArray(value) ? value : [value]) {
      const pv = propValue(v, info);
      if (pv) values.push(pv);
    }
    if (values.length === 0) continue;
    properties.push({ info, values });
    // Two properties can share a title (yours and a built-in one): the rules see both.
    const k = info.title.toLowerCase();
    propValues.set(k, [...(propValues.get(k) ?? []), ...values.map((v) => v.raw)]);
  }
  const parentRaw = obj(raw['block/parent']);
  const parentNode = parentRaw && Object.keys(parentRaw).length > 1 ? toNode(parentRaw, props) : null;
  return {
    id,
    uuid: str(raw['block/uuid']),
    title: str(raw['block/title']) ?? '',
    name: str(raw['block/name']),
    ident: str(raw['db/ident']),
    pageId: idOf(raw['block/page']),
    parentId: idOf(raw['block/parent']),
    order: str(raw['block/order']) ?? '',
    journalDay: num(raw['block/journal-day']),
    status: str(obj(raw['logseq.property/status'])?.['block/title']),
    tags,
    refs,
    props: propValues,
    properties,
    createdAt: num(raw['block/created-at']),
    updatedAt: num(raw['block/updated-at']),
    createdFromProperty: idOf(raw['logseq.property/created-from-property']),
    parent: parentNode,
  };
}

/** Pages, journals, tags and properties are top-level entities: no :block/page. */
export function isPage(n: GNode): boolean {
  return n.pageId === null && (n.name !== null || n.ident !== null);
}

/** Parent chain from a recursive pull, nearest first. */
export function chainOf(n: GNode): GNode[] {
  const out: GNode[] = [];
  const seen = new Set<number>([n.id]);
  let p = n.parent;
  while (p && !seen.has(p.id)) {
    out.push(p);
    seen.add(p.id);
    p = p.parent;
  }
  return out;
}

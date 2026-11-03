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
  /** User properties by lower-cased property title → value titles (or literal values as strings). */
  props: Map<string, string[]>;
  /** Set for the hidden value blocks Logseq creates for text properties. */
  createdFromProperty: number | null;
  /** From a recursive parent pull: the parent chain, nearest first (the page is last). */
  parent: GNode | null;
};

export type PropertyInfo = { id: number; ident: string; title: string; type: string | null };

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

/**
 * Turns a pulled map into a GNode. `props` maps property idents to their titles;
 * attributes of unknown user properties are ignored (and can't match rules).
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
  for (const [key, value] of Object.entries(raw)) {
    if (!key.startsWith('user.property/')) continue;
    const info = props.get(key);
    if (!info) continue;
    const values: string[] = [];
    for (const v of Array.isArray(value) ? value : [value]) {
      const o = obj(v);
      if (o) {
        const t = str(o['block/title']);
        if (t !== null) values.push(t);
        else if (num(o['db/id']) !== null) values.push(`#${String(o['db/id'])}`);
      } else if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        values.push(String(v));
      }
    }
    propValues.set(info.title.toLowerCase(), values);
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

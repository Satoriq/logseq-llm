import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { CliRequest, CliResult } from '../../src/tools/cli.ts';

/**
 * In-memory stand-in for the `logseq` CLI, answering the bridge's fixed queries.
 * Entities 194-203 mirror the real "AI Sandbox" sample (same ids, titles, idents).
 */

type E = {
  id: number;
  uuid: string;
  title: string;
  name?: string;
  ident?: string;
  page?: number;
  parent?: number;
  order?: string;
  journalDay?: number;
  tags?: number[];
  refs?: number[];
  /** Property ident → value: entity id(s) for reference types, the raw value for inline types. */
  props?: Record<string, number | number[] | boolean | string>;
  createdFromProperty?: number;
  status?: string;
  /** Property entities: type, cardinality many, public flag (built-ins). */
  ptype?: string;
  many?: boolean;
  public?: boolean;
  /** Fixed-choice value entities: the property they belong to. */
  closedFor?: number;
  /** logseq.property/value (number values). */
  value?: number | string;
  created?: number;
  updated?: number;
};

const INLINE = new Set(['checkbox', 'datetime', 'string', 'raw-number', 'keyword', 'map', 'coll', 'any', 'json']);

export const AI_ACCESS = 'user.property/ai-access-bUO82pYS';
export const P = {
  priority: 'logseq.property/priority',
  deadline: 'logseq.property/deadline',
  status: 'logseq.property/status',
  createdBy: 'logseq.property/created-by-ref',
  rating: 'user.property/rating-Ab12cdEf',
  done: 'user.property/done-Xy12abCd',
  project: 'user.property/project-Pq12rsTu',
  due: 'user.property/due-Mn12opQr',
  website: 'user.property/website-Gh12ijKl',
  summary: 'user.property/summary-Rs12tuVw',
} as const;
/** 2026-11-05 14:30 local time. */
export const DEADLINE_MS = new Date(2026, 10, 5, 14, 30).getTime();
const u = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export function sampleEntities(): E[] {
  return [
    { id: 194, uuid: '6aea4e44-d2e5-4bab-ac9c-1ff146d6b347', title: 'AI Test', name: 'ai test' },
    { id: 195, uuid: u(195), title: 'private', name: 'private', ident: 'user.class/private-ZzQXdUJm' },
    { id: 196, uuid: u(196), title: 'ai-access', name: 'ai-access', ident: AI_ACCESS, ptype: 'default' },
    { id: 197, uuid: u(197), title: 'AI Test 2', name: 'ai test 2' },
    { id: 198, uuid: 'a558ac4e-ae05-43f3-af22-f167c5f56975', title: 'Apples are red', page: 194, parent: 194, order: 'a0' },
    { id: 199, uuid: '54f76cdd-307a-436e-9716-f129841c97e6', title: 'A child block about apples', page: 194, parent: 198, order: 'a1' },
    { id: 200, uuid: 'ef13d15c-eb66-4eb1-ab54-edbae48baa8e', title: 'This one is secret #private', page: 194, parent: 194, order: 'a2', tags: [195], refs: [195] },
    { id: 201, uuid: '44402c58-25a1-4806-9f1f-f4771a8e2d63', title: 'Local only note', page: 194, parent: 194, order: 'a3', props: { [AI_ACCESS]: 203 } },
    { id: 202, uuid: '05c4b96b-5012-4826-a902-693efb290e0d', title: 'See [[AI Test 2]]', page: 194, parent: 194, order: 'a4', refs: [197] },
    { id: 203, uuid: '6aea4fc6-78b0-4d91-920b-1a99580f503f', title: 'local-only', page: 194, parent: 201, order: 'b1W', createdFromProperty: 196 },
    // Extra cases (not in the real sample):
    { id: 204, uuid: u(204), title: 'Child of secret', page: 194, parent: 200, order: 'a0' },
    { id: 205, uuid: u(205), title: 'Totally secret note', page: 194, parent: 194, order: 'a5', props: { [AI_ACCESS]: 206 } },
    { id: 206, uuid: u(206), title: 'none', page: 194, parent: 205, order: 'a0', createdFromProperty: 196 },
    { id: 207, uuid: u(207), title: 'Buy apples', page: 197, parent: 197, order: 'a0', status: 'Todo' },
    { id: 210, uuid: u(210), title: 'Nov 3rd, 2026', name: 'nov 3rd, 2026', journalDay: 20261103 },
    { id: 211, uuid: u(211), title: 'Journal apples entry', page: 210, parent: 210, order: 'a0' },
    { id: 212, uuid: u(212), title: 'Visible parent', page: 194, parent: 194, order: 'a6' },
    { id: 213, uuid: u(213), title: 'Private child #private', page: 194, parent: 212, order: 'a0', tags: [195] },
    // Properties of every type (ids 220+), on the page "Props Test".
    { id: 220, uuid: u(220), title: 'Priority', ident: P.priority, ptype: 'default', public: true },
    { id: 221, uuid: u(221), title: 'Low', ident: 'logseq.property/priority.low', closedFor: 220, order: 'a0' },
    { id: 222, uuid: u(222), title: 'Medium', ident: 'logseq.property/priority.medium', closedFor: 220, order: 'a1' },
    { id: 223, uuid: u(223), title: 'High', ident: 'logseq.property/priority.high', closedFor: 220, order: 'a2' },
    { id: 224, uuid: u(224), title: 'Deadline', ident: P.deadline, ptype: 'datetime', public: true },
    { id: 225, uuid: u(225), title: 'Status', ident: P.status, ptype: 'default', public: true },
    { id: 226, uuid: u(226), title: 'Todo', ident: 'logseq.property/status.todo', closedFor: 225, order: 'a0' },
    { id: 227, uuid: u(227), title: 'Doing', ident: 'logseq.property/status.doing', closedFor: 225, order: 'a1' },
    { id: 228, uuid: u(228), title: 'Done', ident: 'logseq.property/status.done', closedFor: 225, order: 'a2' },
    { id: 229, uuid: u(229), title: 'Created by', ident: P.createdBy, ptype: 'entity', public: false },
    { id: 230, uuid: u(230), title: 'rating', name: 'rating', ident: P.rating, ptype: 'number' },
    { id: 231, uuid: u(231), title: 'done', name: 'done', ident: P.done, ptype: 'checkbox' },
    { id: 232, uuid: u(232), title: 'project', name: 'project', ident: P.project, ptype: 'node', many: true },
    { id: 233, uuid: u(233), title: 'due', name: 'due', ident: P.due, ptype: 'date' },
    { id: 234, uuid: u(234), title: 'website', name: 'website', ident: P.website, ptype: 'url' },
    { id: 241, uuid: u(241), title: 'summary', name: 'summary', ident: P.summary, ptype: 'default' },
    { id: 235, uuid: u(235), title: 'Alpha', name: 'alpha' },
    { id: 236, uuid: u(236), title: 'Secret Project', name: 'secret project', props: { [AI_ACCESS]: 237 } },
    { id: 237, uuid: u(237), title: 'none', page: 236, parent: 236, order: 'a0', createdFromProperty: 196 },
    { id: 243, uuid: u(243), title: 'Props Test', name: 'props test' },
    {
      id: 238,
      uuid: u(238),
      title: 'Ship the release',
      page: 243,
      parent: 243,
      order: 'a0',
      created: new Date(2026, 10, 1, 9, 0).getTime(),
      updated: new Date(2026, 10, 2, 10, 15).getTime(),
      props: { [P.priority]: 223, [P.deadline]: DEADLINE_MS, [P.rating]: 239, [P.done]: true, [P.project]: [235, 236], [P.due]: 210, [P.website]: 240, [P.summary]: 242 },
    },
    { id: 239, uuid: u(239), title: '', value: 4, page: 243, parent: 238, order: 'b0', createdFromProperty: 230 },
    { id: 240, uuid: u(240), title: 'https://example.com', page: 243, parent: 238, order: 'b1', createdFromProperty: 234 },
    { id: 242, uuid: u(242), title: 'see [[Secret Project]]', page: 243, parent: 238, order: 'b2', createdFromProperty: 241, refs: [236] },
    { id: 244, uuid: u(244), title: 'Plain sibling', page: 243, parent: 243, order: 'a1' },
  ];
}

/**
 * Tiny EDN reader for what the bridge sends in --update-properties / --remove-properties:
 * maps, vectors, keywords (as ":ns/name" strings), strings, numbers, booleans.
 * Maps come back as [key, value] pairs.
 */
export function parseEdn(text: string): unknown {
  let i = 0;
  const ws = (): void => {
    while (i < text.length && /[\s,]/.test(text[i] as string)) i += 1;
  };
  const read = (): unknown => {
    ws();
    const ch = text[i];
    if (ch === '{' || ch === '[') {
      const close = ch === '{' ? '}' : ']';
      i += 1;
      const items: unknown[] = [];
      for (;;) {
        ws();
        if (text[i] === close) {
          i += 1;
          break;
        }
        if (i >= text.length) throw new Error(`EDN: unclosed ${ch}`);
        items.push(read());
      }
      if (ch === '[') return items;
      if (items.length % 2) throw new Error('EDN: odd map');
      const pairs: [unknown, unknown][] = [];
      for (let k = 0; k < items.length; k += 2) pairs.push([items[k], items[k + 1]]);
      return pairs;
    }
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      const str = JSON.parse(text.slice(i, j + 1)) as string;
      i = j + 1;
      return str;
    }
    const m = /^[^\s,\]}]+/.exec(text.slice(i));
    if (!m) throw new Error(`EDN: unexpected ${String(ch)} at ${i}`);
    i += m[0].length;
    const tok = m[0];
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok.startsWith(':')) return tok;
    const n = Number(tok);
    if (!Number.isFinite(n)) throw new Error(`EDN: bad token ${tok}`);
    return n;
  };
  const v = read();
  ws();
  if (i !== text.length) throw new Error('EDN: trailing input');
  return v;
}

export type FakeOptions = {
  entities?: E[];
  /** Whether the AI-GENERATED tag exists (needed for writes). */
  aiTag?: boolean;
  /** owner-source reported for the graph in `server list`. */
  owner?: string;
  graph?: string;
};

export class FakeLogseq {
  readonly byId: Map<number, E>;
  readonly calls: CliRequest[] = [];
  owner: string;
  graph: string;
  #nextId = 1000;

  constructor(opts: FakeOptions = {}) {
    this.byId = new Map((opts.entities ?? sampleEntities()).map((e) => [e.id, e]));
    if (opts.aiTag !== false) this.byId.set(300, { id: 300, uuid: u(300), title: 'ai', name: 'ai', ident: 'user.class/ai-x1' });
    this.byId.set(301, { id: 301, uuid: u(301), title: 'AI-GENERATED', name: 'ai-generated', ident: 'user.class/AI-GENERATED-x2' });
    this.owner = opts.owner ?? 'electron';
    this.graph = opts.graph ?? 'AI Sandbox';
  }

  /** Writes the fake applied (not dry runs). */
  get writes(): CliRequest[] {
    return this.calls.filter((c) => ['upsert block', 'upsert task', 'upsert page', 'remove block'].includes(c.command.join(' ')) && !c.options?.['dry-run']);
  }

  #new(e: Omit<E, 'id' | 'uuid'>): E {
    const id = this.#nextId++;
    const full: E = { id, uuid: u(id), ...e };
    this.byId.set(id, full);
    return full;
  }

  #pageByTitle(title: string): E | undefined {
    return [...this.byId.values()].find((e) => e.name === title.toLowerCase() && e.page === undefined);
  }

  /** A property value as VALUE_PATTERN pulls it. */
  #pullValue(id: number): Record<string, unknown> {
    const t = this.byId.get(id);
    if (!t) return { 'db/id': id };
    const m: Record<string, unknown> = { 'db/id': t.id, 'block/uuid': t.uuid };
    if (t.title !== '') m['block/title'] = t.title;
    if (t.ident) m['db/ident'] = t.ident;
    if (t.name) m['block/name'] = t.name;
    if (t.journalDay) m['block/journal-day'] = t.journalDay;
    if (t.value !== undefined) m['logseq.property/value'] = t.value;
    if (t.createdFromProperty !== undefined) m['logseq.property/created-from-property'] = { 'db/id': t.createdFromProperty };
    if (t.closedFor !== undefined) m['block/closed-value-property'] = [{ 'db/id': t.closedFor }];
    if (t.refs) m['block/refs'] = t.refs.map((r) => this.#refMap(r));
    return m;
  }

  #refMap(r: number): Record<string, unknown> {
    const t = this.byId.get(r);
    return { 'db/id': r, 'block/uuid': t?.uuid, 'block/title': t?.title, ...(t?.name ? { 'block/name': t.name } : {}) };
  }

  #propertyByIdent(ident: string): E | undefined {
    return [...this.byId.values()].find((e) => e.ident === ident && e.ptype !== undefined);
  }

  #pull(id: number, recursive: boolean): Record<string, unknown> | null {
    const e = this.byId.get(id);
    if (!e) return null;
    const m: Record<string, unknown> = { 'db/id': e.id, 'block/uuid': e.uuid, 'block/title': e.title };
    if (e.ident) m['db/ident'] = e.ident;
    if (e.name) m['block/name'] = e.name;
    if (e.order) m['block/order'] = e.order;
    if (e.journalDay) m['block/journal-day'] = e.journalDay;
    if (e.created !== undefined) m['block/created-at'] = e.created;
    if (e.updated !== undefined) m['block/updated-at'] = e.updated;
    if (e.page !== undefined) m['block/page'] = { 'db/id': e.page };
    if (e.createdFromProperty !== undefined) m['logseq.property/created-from-property'] = { 'db/id': e.createdFromProperty };
    if (e.status) {
      const choice = [...this.byId.values()].find((x) => x.closedFor === 225 && x.title.toLowerCase() === e.status?.toLowerCase());
      m['logseq.property/status'] = { 'db/id': choice?.id ?? 900, 'block/title': e.status };
    }
    if (e.tags) m['block/tags'] = e.tags.map((t) => ({ 'db/id': t, 'db/ident': this.byId.get(t)?.ident, 'block/title': this.byId.get(t)?.title }));
    if (e.refs) m['block/refs'] = e.refs.map((r) => this.#refMap(r));
    for (const [ident, v] of Object.entries(e.props ?? {})) {
      const prop = this.#propertyByIdent(ident);
      const inline = prop?.ptype !== undefined && INLINE.has(prop.ptype);
      if (inline) m[ident] = v;
      else if (Array.isArray(v)) m[ident] = v.map((x) => this.#pullValue(x));
      else if (typeof v === 'number') m[ident] = this.#pullValue(v);
    }
    if (e.parent !== undefined) m['block/parent'] = recursive ? this.#pull(e.parent, true) ?? { 'db/id': e.parent } : { 'db/id': e.parent };
    return m;
  }

  #ok(data: unknown): CliResult {
    const stdout = JSON.stringify({ status: 'ok', data });
    return { ok: true, exitCode: 0, json: JSON.parse(stdout), stdout, stderr: '', durationMs: 1 };
  }

  #rows(ids: number[], recursive: boolean): CliResult {
    return this.#ok({ result: ids.map((id) => [this.#pull(id, recursive)]).filter((r) => r[0] !== null) });
  }

  serverList = async (): Promise<CliResult> => this.#ok({ servers: [{ graph: this.graph, 'owner-source': this.owner }] });

  run = async (req: CliRequest): Promise<CliResult> => {
    this.calls.push(req);
    const cmd = req.command.join(' ');
    const o = req.options ?? {};
    const all = [...this.byId.values()];
    if (cmd === 'query') {
      const q = String(o.query);
      const inputs = String(o.inputs ?? '');
      if (q.includes('[?e :logseq.property/type _]')) {
        return this.#ok({
          result: all
            .filter((e) => e.ptype !== undefined)
            .map((e) => [
              {
                'db/id': e.id,
                'db/ident': e.ident,
                'block/title': e.title,
                'logseq.property/type': e.ptype,
                ...(e.many ? { 'db/cardinality': 'db.cardinality/many' } : {}),
                ...(e.public !== undefined ? { 'logseq.property/public?': e.public } : {}),
                ...(all.some((x) => x.closedFor === e.id)
                  ? { 'block/_closed-value-property': all.filter((x) => x.closedFor === e.id).map((x) => ({ 'db/id': x.id, 'block/title': x.title, 'block/order': x.order })) }
                  : {}),
              },
            ]),
        });
      }
      const has = /^\[:find \?b :where \[\?b :(\S+) _\]\]$/.exec(q);
      if (has) {
        const ident = has[1] as string;
        return this.#ok({ result: all.filter((e) => e.props?.[ident] !== undefined || (ident === P.status && e.status)).map((e) => [e.id]) });
      }
      if (q.includes(':block/journal-day ?d]')) {
        const day = JSON.parse(inputs)[0] as number;
        return this.#rows(all.filter((e) => e.journalDay === day).map((e) => e.id), false);
      }
      if (q.includes(':block/name ?name')) {
        const name = JSON.parse(inputs)[0] as string;
        return this.#rows(all.filter((e) => e.name === name).map((e) => e.id), false);
      }
      if (q.includes(':block/page ?pid')) {
        const pid = JSON.parse(inputs)[0] as number;
        return this.#rows(all.filter((e) => e.page === pid).map((e) => e.id), false);
      }
      if (q.includes(':in $ [?e ...]')) {
        // EDN vector of ids: "[[198 199]]" (space-separated, not JSON).
        assert.match(inputs, /^\[\[[\d ]*\]\]$/);
        const ids = [...inputs.matchAll(/\d+/g)].map((m) => Number(m[0]));
        return this.#rows(ids, true);
      }
      if (q.includes(':in $ [?u ...]')) {
        const uuids = [...inputs.matchAll(/#uuid "([^"]+)"/g)].map((m) => m[1]);
        return this.#rows(all.filter((e) => uuids.includes(e.uuid)).map((e) => e.id), true);
      }
      if (q.includes(':find ?b :in $ ?p')) {
        const p = JSON.parse(inputs)[0] as number;
        return this.#ok({ result: all.filter((e) => e.refs?.includes(p)).map((e) => [e.id]) });
      }
      throw new Error(`fake logseq: unexpected query ${q}`);
    }
    const contains = (e: E): boolean => e.title.toLowerCase().includes(String(o.content ?? '').toLowerCase());
    if (cmd === 'search block') return this.#ok({ items: all.filter((e) => e.page !== undefined && contains(e)).map((e) => ({ 'db/id': e.id, 'block/title': e.title })) });
    if (cmd === 'search page') return this.#ok({ items: all.filter((e) => e.page === undefined && contains(e)).map((e) => ({ 'db/id': e.id, 'block/title': e.title })) });
    if (cmd === 'list task') return this.#ok({ items: all.filter((e) => e.status).map((e) => ({ id: e.id, title: e.title, status: e.status })) });
    if (cmd === 'list page') return this.#ok({ items: all.filter((e) => e.name && !e.ident).map((e) => ({ id: e.id, title: e.title })) });
    if (cmd === 'search tag') return this.#ok({ items: all.filter((e) => e.ident?.startsWith('user.class/') && contains(e)).map((e) => ({ 'db/id': e.id, 'block/title': e.title })) });
    if (req.command[0] === 'upsert' || req.command[0] === 'remove') {
      assert.equal(req.allowWrite, true, 'writes must come from the approved-write path');
      // EDN vectors of tag names → tag entity ids.
      const names = (v: unknown): string[] => [...String(v ?? '').matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => (m[1] as string).toLowerCase());
      const tagIds = (v: unknown): number[] => names(v).map((n) => all.find((e) => e.ident?.startsWith('user.class/') && e.title.toLowerCase() === n)?.id).filter((x): x is number => x !== undefined);
      const tags = tagIds(o['update-tags']);
      const removeTags = tagIds(o['remove-tags']);
      if (cmd === 'upsert tag') {
        const e = this.#new({ title: String(o.name), name: String(o.name).toLowerCase(), ident: `user.class/${String(o.name)}-new` });
        return this.#ok({ result: [e.id] });
      }
      if (cmd === 'upsert block' && o['blocks-file']) {
        const md = readFileSync(String(o['blocks-file']), 'utf8');
        const lines = md.split('\n').filter((l) => /^\s*- /.test(l));
        const titles = [...md.matchAll(/\[\[([^\]]+)\]\]/g)].map((m) => m[1] as string).filter((t) => !this.#pageByTitle(t));
        if (o['dry-run']) return this.#ok({ 'dry-run': true, ops: [], 'would-create-pages': titles });
        const parentE = o['target-page'] ? this.#pageByTitle(String(o['target-page'])) : all.find((e) => e.uuid === o['target-uuid']);
        if (!parentE) return { ok: false, exitCode: 1, json: { status: 'error', error: { code: 'not-found', message: 'target not found' } }, stdout: '', stderr: '', durationMs: 1 };
        const pageId = parentE.page ?? parentE.id;
        const stack: { depth: number; id: number }[] = [];
        const ids: number[] = [];
        for (const l of lines) {
          const depth = (l.match(/^\s*/)?.[0].length ?? 0) / 2;
          while (stack.length && (stack.at(-1) as { depth: number }).depth >= depth) stack.pop();
          const parent = stack.at(-1)?.id ?? (o.pos === 'sibling' ? (parentE.parent ?? pageId) : parentE.id);
          const e = this.#new({ title: l.replace(/^\s*- /, ''), page: pageId, parent, order: 'z' + ids.length, tags });
          ids.push(e.id);
          stack.push({ depth, id: e.id });
        }
        return this.#ok({ result: ids });
      }
      if (cmd === 'upsert block' && o.uuid) {
        const e = all.find((x) => x.uuid === o.uuid);
        if (!e) return { ok: false, exitCode: 1, json: null, stdout: '', stderr: 'not found', durationMs: 1 };
        if (o.content !== undefined) e.title = String(o.content);
        e.tags = [...new Set([...(e.tags ?? []), ...tags])].filter((t) => !removeTags.includes(t));
        // Same order as the real CLI: remove properties, then set them.
        for (const ident of parseEdn(String(o['remove-properties'] ?? '[]')) as string[]) {
          if (e.props) delete e.props[String(ident).replace(/^:/, '')];
        }
        const sets = o['update-properties'] === undefined ? [] : (parseEdn(String(o['update-properties'])) as [string, unknown][]);
        for (const [k, v] of sets) {
          const ident = k.replace(/^:/, '');
          const prop = this.#propertyByIdent(ident);
          if (!prop) return { ok: false, exitCode: 1, json: { status: 'error', error: { code: 'property-not-found', message: `property not found: ${ident}` } }, stdout: '', stderr: '', durationMs: 1 };
          const one = (x: unknown): number | boolean | string => {
            if (prop.ptype && INLINE.has(prop.ptype)) return x as number | boolean | string;
            if (typeof x === 'number' && Number.isInteger(x) && prop.ptype !== 'number') return x;
            const vb = this.#new({ title: typeof x === 'string' ? x : '', ...(typeof x === 'number' ? { value: x } : {}), page: e.page ?? e.id, parent: e.id, order: 'v', createdFromProperty: prop.id });
            return vb.id;
          };
          e.props = { ...(e.props ?? {}), [ident]: Array.isArray(v) ? (v.map(one) as number[]) : one(v) };
        }
        return this.#ok({ result: [e.id] });
      }
      if (cmd === 'upsert block' && o.id) {
        const e = this.byId.get(Number(o.id));
        if (e) e.tags = [...new Set([...(e.tags ?? []), ...tags])];
        return this.#ok({ result: [Number(o.id)] });
      }
      if (cmd === 'upsert task' && o.uuid) {
        const e = all.find((x) => x.uuid === o.uuid);
        const choice = all.find((x) => x.closedFor === 225 && x.title.toLowerCase().replace(/ /g, '-') === String(o.status));
        if (!e || !choice) return { ok: false, exitCode: 1, json: { status: 'error', error: { code: 'invalid', message: 'bad task update' } }, stdout: '', stderr: '', durationMs: 1 };
        e.status = choice.title;
        return this.#ok({ result: [e.id] });
      }
      if (cmd === 'upsert task') {
        const parentE = o['target-page'] ? this.#pageByTitle(String(o['target-page'])) : all.find((e) => e.uuid === o['target-uuid']);
        const pageId = parentE?.page ?? parentE?.id ?? 0;
        const e = this.#new({ title: String(o.content), page: pageId, parent: parentE?.id ?? pageId, order: 'zz', status: String(o.status) });
        return this.#ok({ result: [e.id] });
      }
      if (cmd === 'upsert page') {
        const e = this.#new({ title: String(o.page), name: String(o.page).toLowerCase(), tags });
        return this.#ok({ result: [e.id] });
      }
      if (cmd === 'remove block') {
        const root = all.find((e) => e.uuid === o.uuid);
        const drop = (id: number): void => {
          for (const k of [...this.byId.values()].filter((x) => x.parent === id)) drop(k.id);
          this.byId.delete(id);
        };
        if (root) drop(root.id);
        return this.#ok({ result: root ? [root.id] : [] });
      }
    }
    throw new Error(`fake logseq: unexpected command ${cmd}`);
  };
}

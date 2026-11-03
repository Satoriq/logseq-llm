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
  props?: Record<string, number>;
  createdFromProperty?: number;
  status?: string;
};

export const AI_ACCESS = 'user.property/ai-access-bUO82pYS';
const u = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export function sampleEntities(): E[] {
  return [
    { id: 194, uuid: '6aea4e44-d2e5-4bab-ac9c-1ff146d6b347', title: 'AI Test', name: 'ai test' },
    { id: 195, uuid: u(195), title: 'private', name: 'private', ident: 'user.class/private-ZzQXdUJm' },
    { id: 196, uuid: u(196), title: 'ai-access', name: 'ai-access', ident: AI_ACCESS },
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
  ];
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
    if (opts.aiTag !== false) this.byId.set(300, { id: 300, uuid: u(300), title: 'AI-GENERATED', name: 'ai-generated', ident: 'user.class/AI-GENERATED-x1' });
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

  #pull(id: number, recursive: boolean): Record<string, unknown> | null {
    const e = this.byId.get(id);
    if (!e) return null;
    const m: Record<string, unknown> = { 'db/id': e.id, 'block/uuid': e.uuid, 'block/title': e.title };
    if (e.ident) m['db/ident'] = e.ident;
    if (e.name) m['block/name'] = e.name;
    if (e.order) m['block/order'] = e.order;
    if (e.journalDay) m['block/journal-day'] = e.journalDay;
    if (e.page !== undefined) m['block/page'] = { 'db/id': e.page };
    if (e.createdFromProperty !== undefined) m['logseq.property/created-from-property'] = { 'db/id': e.createdFromProperty };
    if (e.status) m['logseq.property/status'] = { 'db/id': 900, 'block/title': e.status };
    if (e.tags) m['block/tags'] = e.tags.map((t) => ({ 'db/id': t, 'db/ident': this.byId.get(t)?.ident, 'block/title': this.byId.get(t)?.title }));
    if (e.refs) {
      m['block/refs'] = e.refs.map((r) => {
        const t = this.byId.get(r);
        return { 'db/id': r, 'block/uuid': t?.uuid, 'block/title': t?.title, ...(t?.name ? { 'block/name': t.name } : {}) };
      });
    }
    for (const [ident, valueId] of Object.entries(e.props ?? {})) {
      m[ident] = { 'db/id': valueId, 'block/title': this.byId.get(valueId)?.title };
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
      if (q.includes('(namespace ?i)')) {
        return this.#ok({
          result: all.filter((e) => e.ident?.startsWith('user.property/')).map((e) => [{ 'db/id': e.id, 'db/ident': e.ident, 'block/title': e.title, 'logseq.property/type': 'default' }]),
        });
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
      const tags = String(o['update-tags'] ?? '').includes('AI-GENERATED') ? [300] : [];
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
        e.title = String(o.content);
        e.tags = [...new Set([...(e.tags ?? []), ...tags])];
        return this.#ok({ result: [e.id] });
      }
      if (cmd === 'upsert block' && o.id) {
        const e = this.byId.get(Number(o.id));
        if (e) e.tags = [...new Set([...(e.tags ?? []), ...tags])];
        return this.#ok({ result: [Number(o.id)] });
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

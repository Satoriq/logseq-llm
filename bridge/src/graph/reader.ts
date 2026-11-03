import type { CliRequest, CliResult } from '../tools/cli.ts';
import { resultItems, resultRows, toNode } from './entity.ts';
import type { GNode, PropertyInfo } from './entity.ts';

/**
 * Read access to the graph through fixed Datascript queries run by the `logseq` CLI.
 *
 * Injection rules: user- or model-supplied values never go into the query text. They go
 * through --inputs as EDN literals built here (integers, validated UUIDs, JSON-escaped
 * strings). The only identifiers spliced into the pull pattern are property idents read
 * from the graph, and those must match a strict pattern.
 */

export type CliRunner = (req: CliRequest) => Promise<CliResult>;

export class GraphError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROPERTY_IDENT_RE = /^user\.property\/[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;

export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

/** EDN string literal. JSON escapes are valid EDN for these characters. */
export function ednString(s: string): string {
  return JSON.stringify(s);
}

function ednIds(ids: readonly number[]): string {
  for (const id of ids) if (!Number.isSafeInteger(id) || id < 0) throw new GraphError('bad-id', 'invalid entity id');
  return `[${ids.join(' ')}]`;
}

function ednUuids(uuids: readonly string[]): string {
  for (const u of uuids) if (!isUuid(u)) throw new GraphError('bad-uuid', `not a UUID: ${u.slice(0, 40)}`);
  return `[${uuids.map((u) => `#uuid "${u.toLowerCase()}"`).join(' ')}]`;
}

const PROPERTIES_QUERY =
  '[:find (pull ?e [:db/id :db/ident :block/title :logseq.property/type]) :where [?e :db/ident ?i] [(namespace ?i) ?ns] [(= ?ns "user.property")]]';

export class GraphReader {
  readonly graph: string | null;
  #run: CliRunner;
  #props: Map<string, PropertyInfo> | null = null;
  #propsAt = 0;
  readonly propsTtlMs: number;

  constructor(opts: { run: CliRunner; graph: string | null; propsTtlMs?: number }) {
    this.#run = opts.run;
    this.graph = opts.graph;
    this.propsTtlMs = opts.propsTtlMs ?? 60_000;
  }

  async #query(query: string, inputs?: string): Promise<Record<string, unknown>[]> {
    const r = await this.#run({ command: ['query'], graph: this.graph, options: { query, ...(inputs !== undefined ? { inputs } : {}) } });
    if (!r.ok) throw cliError(r);
    return resultRows(r.json);
  }

  /** User properties (ident → info). Cached; idents carry a random suffix, so rules match by title. */
  async properties(): Promise<Map<string, PropertyInfo>> {
    if (this.#props && Date.now() - this.#propsAt < this.propsTtlMs) return this.#props;
    const rows = await this.#query(PROPERTIES_QUERY);
    const map = new Map<string, PropertyInfo>();
    for (const r of rows) {
      const ident = typeof r['db/ident'] === 'string' ? r['db/ident'] : null;
      const id = typeof r['db/id'] === 'number' ? r['db/id'] : null;
      if (ident === null || id === null || !PROPERTY_IDENT_RE.test(ident)) continue;
      const title = typeof r['block/title'] === 'string' ? r['block/title'] : ident;
      map.set(ident, { id, ident, title, type: typeof r['logseq.property/type'] === 'string' ? r['logseq.property/type'] : null });
    }
    this.#props = map;
    this.#propsAt = Date.now();
    return map;
  }

  async #pattern(recursiveParent: boolean): Promise<{ pattern: string; props: Map<string, PropertyInfo> }> {
    const props = await this.properties();
    const propPulls = [...props.keys()].map((ident) => `{:${ident} [:db/id :block/title]}`).join(' ');
    const parent = recursiveParent ? '{:block/parent ...}' : '{:block/parent [:db/id]}';
    const pattern =
      '[:db/id :db/ident :block/uuid :block/title :block/name :block/order :block/journal-day ' +
      '{:logseq.property/created-from-property [:db/id]} {:logseq.property/status [:db/id :block/title]} {:block/page [:db/id]} ' +
      '{:block/tags [:db/id :db/ident :block/title]} {:block/refs [:db/id :block/uuid :block/title :block/name]} ' +
      `${propPulls} ${parent}]`;
    return { pattern, props };
  }

  #nodes(rows: Record<string, unknown>[], props: Map<string, PropertyInfo>): GNode[] {
    return rows.map((r) => toNode(r, props)).filter((n): n is GNode => n !== null);
  }

  /** A page by title (case-insensitive). */
  async pageByTitle(title: string): Promise<GNode | null> {
    const { pattern, props } = await this.#pattern(false);
    const rows = await this.#query(`[:find (pull ?p ${pattern}) :in $ ?name :where [?p :block/name ?name]]`, `[${ednString(title.toLowerCase())}]`);
    return this.#nodes(rows, props)[0] ?? null;
  }

  /** All blocks on a page (flat; the caller builds the tree). */
  async pageBlocks(pageId: number): Promise<GNode[]> {
    if (!Number.isSafeInteger(pageId) || pageId < 0) throw new GraphError('bad-id', 'invalid entity id');
    const { pattern, props } = await this.#pattern(false);
    const rows = await this.#query(`[:find (pull ?b ${pattern}) :in $ ?pid :where [?b :block/page ?pid]]`, `[${pageId}]`);
    return this.#nodes(rows, props);
  }

  /** Entities by id with their full parent chain (for policy checks), in the order of `ids`. */
  async byIds(ids: readonly number[]): Promise<GNode[]> {
    if (ids.length === 0) return [];
    const { pattern, props } = await this.#pattern(true);
    const rows = await this.#query(`[:find (pull ?e ${pattern}) :in $ [?e ...]]`, `[${ednIds(ids)}]`);
    const rank = new Map(ids.map((id, i) => [id, i]));
    return this.#nodes(rows, props).sort((a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0));
  }

  /** Entities by UUID with their full parent chain. */
  async byUuids(uuids: readonly string[]): Promise<GNode[]> {
    if (uuids.length === 0) return [];
    const { pattern, props } = await this.#pattern(true);
    const rows = await this.#query(`[:find (pull ?e ${pattern}) :in $ [?u ...] :where [?e :block/uuid ?u]]`, `[${ednUuids(uuids)}]`);
    return this.#nodes(rows, props);
  }

  /** Blocks that reference a page (backlinks), with parent chains. */
  async backlinks(pageId: number, limit: number): Promise<GNode[]> {
    if (!Number.isSafeInteger(pageId) || pageId < 0) throw new GraphError('bad-id', 'invalid entity id');
    const r = await this.#run({ command: ['query'], graph: this.graph, options: { query: '[:find ?b :in $ ?p :where [?b :block/refs ?p]]', inputs: `[${pageId}]` } });
    if (!r.ok) throw cliError(r);
    const ids = idsFromTuples(r.json).slice(0, limit);
    return this.byIds(ids);
  }

  async searchBlocks(text: string): Promise<number[]> {
    return this.#itemIds(['search', 'block'], { content: text });
  }

  async searchPages(text: string): Promise<number[]> {
    return this.#itemIds(['search', 'page'], { content: text });
  }

  async listTasks(opts: { status?: string; limit: number }): Promise<number[]> {
    return this.#itemIds(['list', 'task'], { fields: 'id,title,status', limit: opts.limit, ...(opts.status ? { status: opts.status } : {}) });
  }

  async listPages(opts: { journalOnly: boolean; limit: number }): Promise<number[]> {
    return this.#itemIds(['list', 'page'], {
      fields: 'id,title',
      limit: opts.limit,
      sort: 'updated-at',
      order: 'desc',
      ...(opts.journalOnly ? { 'journal-only': true } : {}),
    });
  }

  async #itemIds(command: string[], options: Record<string, string | number | boolean>): Promise<number[]> {
    const r = await this.#run({ command, graph: this.graph, options });
    if (!r.ok) throw cliError(r);
    const ids: number[] = [];
    for (const item of resultItems(r.json)) {
      const id = item['db/id'] ?? item.id;
      if (typeof id === 'number' && Number.isSafeInteger(id)) ids.push(id);
    }
    return ids;
  }
}

function idsFromTuples(json: unknown): number[] {
  const result = (json as { data?: { result?: unknown } } | null)?.data?.result;
  if (!Array.isArray(result)) return [];
  const out: number[] = [];
  for (const row of result) {
    const v = Array.isArray(row) ? row[0] : row;
    if (typeof v === 'number' && Number.isSafeInteger(v)) out.push(v);
  }
  return out;
}

function cliError(r: CliResult): GraphError {
  const err = (r.json as { error?: { code?: unknown; message?: unknown } } | null)?.error;
  const code = typeof err?.code === 'string' ? err.code : `exit-${r.exitCode}`;
  const message = typeof err?.message === 'string' ? err.message : r.stderr.trim().split('\n')[0] ?? 'logseq CLI failed';
  return new GraphError(code, message);
}

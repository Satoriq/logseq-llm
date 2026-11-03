import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApprovalRequest, ApprovalView } from '../approvals.ts';
import type { AutoApplyMode } from '../config.ts';
import type { AuditLog } from '../audit.ts';
import { chainOf, formatDateTime, formatJournalDay, isPage, resultItems } from '../graph/entity.ts';
import type { GNode, PropEntry, PropertyInfo } from '../graph/entity.ts';
import { ednString, GraphError, isUuid } from '../graph/reader.ts';
import type { GraphReader } from '../graph/reader.ts';
import { ACCESS_PROPERTY, visibleTo } from '../policy/policy.ts';
import type { Policy } from '../policy/policy.ts';
import { HIDDEN_MARK } from '../policy/redact.ts';
import type { CliRequest, CliResult } from './cli.ts';
import { canSet, parseDateTime, parseDay, resolveProperty } from './properties.ts';
import { argString, ToolInputError } from './registry.ts';
import type { ToolContext, ToolDef, ToolOutput } from './registry.ts';

/**
 * Write tools. Nothing is written until you click Apply on the card in the panel:
 *   check (target visible to this model, graph in writeGraphs, content rules)
 *   → preview (CLI --dry-run where the CLI supports it, otherwise built from a read)
 *   → approval card → Apply runs exactly the previewed command → result back to the model.
 * The top block of whatever the AI writes is tagged #ai (config "aiTag"); blocks under an
 * already-tagged block are not tagged again, so a poem keeps one tag on its title.
 */

export const DEFAULT_AI_TAG = 'ai';
const TAG_NAME_RE = /^[^\n"\\[\]]{1,80}$/;

/** EDN vector of tag names for --update-tags / --remove-tags. */
function tagsEdn(names: readonly string[]): string {
  return `[${names.map(ednString).join(' ')}]`;
}
function escapeRe(x: string): string {
  return x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True if the text carries the tag as #tag, #[[tag]] or [[tag]]. */
function mentionsTag(text: string, tag: string): boolean {
  const t = escapeRe(tag);
  return new RegExp(`#${t}(?![\\w/-])|#?\\[\\[${t}\\]\\]`, 'i').test(text);
}

/** Only idents read from the graph get here; this is a second guard before they go into EDN. */
const SAFE_IDENT_RE = /^[A-Za-z0-9.*+!_?<>=-]+\/[A-Za-z0-9.*+!_?<>=-]+$/;
function ednKeyword(ident: string): string {
  if (!SAFE_IDENT_RE.test(ident)) throw new GraphError('bad-property', 'unsafe property ident');
  return `:${ident}`;
}

const STATUS_IDENT = 'logseq.property/status';

/** A property value as the user sees it on the card (the user may see everything). */
function cardValue(e: PropEntry): string {
  return e.values.map((v) => (v.target?.isPage && v.target.title === v.text ? `[[${v.text}]]` : v.target && !v.target.isPage && v.target.uuid ? `((${v.target.uuid}))` : v.text)).join(', ');
}

const MAX_BLOCKS = 200;
const MAX_CHARS = 50_000;

export type WriteToolDeps = {
  run: (req: CliRequest) => Promise<CliResult>;
  reader: GraphReader;
  policy: Policy;
  ensureGraph: () => Promise<void>;
  graph: string | null;
  writeGraphs: readonly string[];
  /** For the temporary blocks file (mode 0600), deleted when the approval is settled. */
  runDir: string;
  audit?: AuditLog;
  /** This graph's autoApply setting (default none). */
  autoApply?: AutoApplyMode;
  /** What the AI created in each chat (for autoApply "own"). */
  own?: OwnBlocks;
  /** Tag for AI-written blocks (default "ai"). */
  aiTag?: string;
};

export type OwnBlocks = {
  list: (chatId: string) => Promise<Set<string>>;
  add: (chatId: string, uuids: string[]) => Promise<void>;
};

const ADDITIONS = new Set(['insert_blocks', 'create_task', 'create_page']);

type Applied = {
  /** For the model (may list block ids). */
  summary: string;
  /** For the card (short, no ids). */
  short: string;
  targetUuids: string[];
  /** New blocks/pages, remembered as the AI's own in this chat. */
  created?: string[];
};

/** Thrown when you Abort a batch part-way. */
class AbortedApply extends Error {
  readonly done: number;
  readonly total: number;
  constructor(done: number, total: number) {
    super(`stopped after ${done} of ${total}`);
    this.done = done;
    this.total = total;
  }
}

/** Auto-applied edits and deletes wait this long, so you can Abort them. */
export const AUTO_GRACE_MS = 2000;

type ApplyOpts = { signal?: AbortSignal; progress?: (done: number, total: number) => void };

type Prepared = {
  approval: ApprovalRequest;
  /** Runs the change exactly as previewed. */
  apply: (o: ApplyOpts) => Promise<Applied>;
  cleanup?: () => Promise<void>;
  targetUuids: string[];
  /** For edits/deletes: the blocks that must all be the AI's own (this chat) for autoApply "own". */
  ownTargets?: string[];
};

function cliMessage(r: CliResult): string {
  const err = (r.json as { error?: { message?: unknown } } | null)?.error;
  return typeof err?.message === 'string' ? err.message : r.stderr.trim().split('\n')[0] || `logseq exited with ${r.exitCode}`;
}

function resultIds(json: unknown): number[] {
  const data = (json as { data?: unknown } | null)?.data as Record<string, unknown> | undefined;
  const raw = data?.result ?? data?.ids ?? data?.id;
  const list = Array.isArray(raw) ? raw : raw === undefined ? [] : [raw];
  return list.filter((v): v is number => typeof v === 'number' && Number.isSafeInteger(v));
}

function quote(s: string, max = 60): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return `"${one.length > max ? `${one.slice(0, max)}…` : one}"`;
}

/**
 * Accepts a Logseq outline ("- a\n  - b", properties as "  key:: value") or plain text
 * (each line becomes a block). Returns the outline and its block count.
 */
export function normalizeOutline(md: string): { markdown: string; blocks: number } {
  const text = md.replace(/\r\n?/g, '\n').replace(/\t/g, '  ').replace(/\s+$/, '');
  if (text.trim() === '') throw new ToolInputError('"markdown" is empty');
  if (text.length > MAX_CHARS) throw new ToolInputError(`"markdown" is too long (max ${MAX_CHARS} characters)`);
  const lines = text.split('\n');
  const outline = lines.some((l) => /^\s*- /.test(l));
  const out = outline ? lines : lines.filter((l) => l.trim() !== '').map((l) => `- ${l.trim()}`);
  const blocks = out.filter((l) => /^\s*- /.test(l)).length;
  if (blocks > MAX_BLOCKS) throw new ToolInputError(`too many blocks (max ${MAX_BLOCKS})`);
  if (outline && !/^- /.test(out.find((l) => l.trim() !== '') ?? '')) throw new ToolInputError('the outline must start with a top-level "- " block');
  return { markdown: out.join('\n'), blocks };
}

export function writeTools(deps: WriteToolDeps): ToolDef[] {
  let tagChecked = false;

  const writable = (): string => {
    if (deps.graph === null || !deps.writeGraphs.includes(deps.graph)) {
      throw new ToolInputError(
        deps.graph === null
          ? 'Writes are turned off (no graph configured).'
          : `Writes are turned off for the graph "${deps.graph}". The user can allow them by adding it to "writeGraphs" in the bridge's config.json.`,
      );
    }
    return deps.graph;
  };

  const aiTag = deps.aiTag ?? DEFAULT_AI_TAG;
  const tagExists = async (graph: string, name: string): Promise<boolean> => {
    const r = await deps.run({ command: ['search', 'tag'], graph, options: { content: name } });
    if (!r.ok) throw new GraphError('cli', cliMessage(r));
    return resultItems(r.json).some((i) => String(i['block/title'] ?? i.title ?? '').toLowerCase() === name.toLowerCase());
  };

  /** The AI tag must exist before it's used; in a writable graph the bridge creates it once. */
  const ensureTag = async (graph: string): Promise<void> => {
    if (tagChecked) return;
    if (!(await tagExists(graph, aiTag))) {
      const r = await deps.run({ command: ['upsert', 'tag'], graph, allowWrite: true, options: { name: aiTag } });
      if (!r.ok) {
        throw new ToolInputError(`The tag "${aiTag}" doesn't exist and couldn't be created (${cliMessage(r)}). The user can create it with: logseq upsert tag --graph="${graph}" --name=${aiTag}`);
      }
      void deps.audit?.record({ kind: 'write', chatId: 'bridge', tool: 'create_ai_tag', outcome: 'applied' });
    }
    tagChecked = true;
  };

  /** True if the block, a parent, or the page already carries the AI tag. */
  const underAiTag = (nodes: readonly GNode[]): boolean =>
    nodes.some((n) => n.tags.some((t) => t.title.toLowerCase() === aiTag.toLowerCase()));

  const visibleBlock = async (uuid: string, ctx: ToolContext): Promise<{ node: GNode; chain: GNode[] }> => {
    if (!isUuid(uuid)) throw new ToolInputError('"uuid" must be a block uuid');
    const node = (await deps.reader.byUuids([uuid]))[0];
    const missing = new ToolInputError(`No block with id ${uuid}.`);
    if (!node || node.createdFromProperty !== null || isPage(node)) throw missing;
    const chain = chainOf(node);
    if (!visibleTo(deps.policy.evaluate({ node, chain }).visibility, ctx.locality)) throw missing;
    return { node, chain };
  };

  const visiblePage = async (title: string, ctx: ToolContext): Promise<GNode> => {
    const page = await deps.reader.pageByTitle(title);
    if (!page || !visibleTo(deps.policy.evaluate({ node: page, chain: [] }).visibility, ctx.locality)) {
      throw new ToolInputError(`No page named "${title}". (Use create_page first if it should be new.)`);
    }
    return page;
  };

  /** Content rules for anything the AI writes. Returns warnings for the card. */
  const checkContent = async (text: string, ctx: ToolContext): Promise<string[]> => {
    if (text.toLowerCase().includes(HIDDEN_MARK)) {
      throw new ToolInputError(`The text contains "${HIDDEN_MARK}". That marks something the user's privacy settings hide from you; writing it would overwrite the real content. Leave that part out or ask the user.`);
    }
    if (new RegExp(`^\\s*(-\\s+)?${ACCESS_PROPERTY}::`, 'im').test(text)) {
      throw new ToolInputError(`The "${ACCESS_PROPERTY}" property is the user's privacy setting; only the user may set it.`);
    }
    const warnings: string[] = [];
    if (/!\[[^\]]*\]\([^)]*\)/.test(text)) warnings.push('Contains an image link: Logseq will load it from the internet when you view the page.');
    const urls = [...new Set(text.match(/https?:\/\/[^\s)\]>]+/g) ?? [])];
    if (urls.length > 0) warnings.push(`Contains ${urls.length} web link(s): ${urls.slice(0, 3).join(', ')}${urls.length > 3 ? ', …' : ''}`);
    const refs = [...new Set([...text.matchAll(/\[\[([^\]\n]{1,200})\]\]/g)].map((m) => m[1] ?? '').filter((t) => t && !isUuid(t)))].slice(0, 20);
    for (const title of refs) {
      const page = await deps.reader.pageByTitle(title);
      if (!page) continue; // new pages are reported by the dry run / below
      if (!visibleTo(deps.policy.evaluate({ node: page, chain: [] }).visibility, ctx.locality)) {
        warnings.push(`Links to "${title}", a page this AI can't see.`);
      }
    }
    return warnings;
  };

  const newPagesIn = async (text: string): Promise<string[]> => {
    const refs = [...new Set([...text.matchAll(/\[\[([^\]\n]{1,200})\]\]/g)].map((m) => m[1] ?? '').filter((t) => t && !isUuid(t)))].slice(0, 20);
    const out: string[] = [];
    for (const t of refs) if (!(await deps.reader.pageByTitle(t))) out.push(t);
    return out;
  };

  const run = async (req: Omit<CliRequest, 'allowWrite'>): Promise<CliResult> => deps.run({ ...req, allowWrite: true });

  const uuidsOf = async (ids: number[]): Promise<string[]> => {
    if (ids.length === 0) return [];
    return (await deps.reader.byIds(ids)).map((n) => n.uuid).filter((u): u is string => u !== null);
  };

  /** Shared flow: prepare → card → apply or not → tell the model. */
  const withApproval = (name: string, prepare: (args: Record<string, unknown>, ctx: ToolContext, graph: string) => Promise<Prepared>) =>
    async (args: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput> => {
      if (!ctx.approve) throw new ToolInputError('Writes need the Logseq AI panel, where you approve them.');
      await deps.ensureGraph();
      const graph = writable();
      await ensureTag(graph);
      const prepared = await prepare(args, ctx, graph);
      const mode = deps.autoApply ?? 'none';
      const clean = prepared.approval.warnings.length === 0;
      // Additions skip the card only when it would show no warnings (links, images, new pages, hidden refs).
      let auto = mode === 'all' || ((mode === 'additions' || mode === 'own') && ADDITIONS.has(name) && clean);
      // "own": edits/deletes skip it too, if every block they touch was added by the AI in this chat.
      if (!auto && mode === 'own' && clean && ctx.chatId && deps.own && prepared.ownTargets && prepared.ownTargets.length > 0) {
        const mine = await deps.own.list(ctx.chatId);
        auto = prepared.ownTargets.every((u) => mine.has(u.toLowerCase()));
      }
      try {
        // Edits/deletes get a short window to Abort when they're applied without a click.
        const graceMs = ADDITIONS.has(name) ? 0 : AUTO_GRACE_MS;
        const { view, decision } = await ctx.approve({ ...prepared.approval, graceMs, ...(auto ? { auto: true } : {}) });
        const done = (outcome: 'applied' | 'rejected' | 'failed' | 'aborted', detail: string, targetUuids: string[]): void => {
          ctx.resolved?.(view as ApprovalView, outcome, detail);
          void deps.audit?.record({ kind: 'write', chatId: ctx.chatId ?? 'cli', ...(ctx.turnId ? { turnId: ctx.turnId } : {}), tool: name, outcome, targetUuids, locality: ctx.locality });
        };
        if (decision.decision !== 'apply') {
          const why =
            decision.reason === 'timeout'
              ? 'No answer from the user within the time limit; nothing was changed.'
              : decision.reason === 'no-panel'
                ? "The user can't see approval cards right now (their Logseq AI panel isn't open on this chat or needs an update); nothing was changed. Tell them, and don't retry until they say so."
              : decision.reason === 'aborted'
                ? "The user aborted this change before it was applied; nothing was changed. Don't retry it unless they ask."
              : decision.reason === 'cancelled'
                ? 'The user stopped this turn; nothing was changed.'
                : `The user rejected this change; nothing was changed.${decision.note ? ` Their note: ${quote(decision.note, 500)}` : ''} Don't retry the same change unless they ask.`;
          done(decision.reason === 'aborted' ? 'aborted' : 'rejected', decision.reason === 'user' ? (decision.note ?? 'rejected') : (decision.reason ?? 'rejected'), prepared.targetUuids);
          return { text: why, sentUuids: [], hiddenCount: 0 };
        }
        try {
          if (decision.signal?.aborted) throw new AbortedApply(0, 1);
          const r = await prepared.apply({
            ...(decision.signal ? { signal: decision.signal } : {}),
            progress: (n, total) => ctx.progress?.(view as ApprovalView, n, total),
          });
          if (r.created?.length && ctx.chatId && deps.own) await deps.own.add(ctx.chatId, r.created);
          done('applied', r.short, r.targetUuids);
          return { text: `Applied: ${r.summary}`, sentUuids: [], hiddenCount: 0 };
        } catch (err) {
          if (err instanceof AbortedApply) {
            const detail = err.done === 0 ? 'nothing applied' : `${err.done} of ${err.total} applied`;
            done('aborted', detail, prepared.targetUuids);
            return {
              text: `The user aborted this change: ${err.done === 0 ? 'nothing was changed' : `${err.done} of ${err.total} edits had been applied, the rest were not`}. Don't retry it unless they ask.`,
              sentUuids: [],
              hiddenCount: 0,
            };
          }
          const msg = (err as Error).message;
          done('failed', msg, prepared.targetUuids);
          return { text: `Logseq refused the change: ${msg}`, sentUuids: [], hiddenCount: 0 };
        }
      } finally {
        await prepared.cleanup?.();
      }
    };

  const insertBlocks: ToolDef = {
    name: 'insert_blocks',
    kind: 'write',
    description:
      'Propose adding blocks to the graph. The user sees a preview and must approve it. Give either "page" (adds at the end of that page, or at the start with position "first-child") ' +
      'or "parent_uuid" (adds as children of that block, or right after it with position "after"). "markdown" is a Logseq outline: "- block" lines, two spaces per level for children.',
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'string', description: 'Title of an existing page' },
        parent_uuid: { type: 'string', description: 'Block uuid ([id:...] from a read)' },
        position: { type: 'string', enum: ['last-child', 'first-child', 'after'] },
        markdown: { type: 'string', description: 'Outline, e.g. "- Summary\\n  - point one"' },
      },
      required: ['markdown'],
      additionalProperties: false,
    },
    label: (a) => `proposing new blocks${a.page ? ` on "${String(a.page).slice(0, 40)}"` : ''}`,
    run: withApproval('insert_blocks', async (args, ctx, graph) => {
      const page = argString(args, 'page', { required: false, max: 300 });
      const parent = argString(args, 'parent_uuid', { required: false, max: 64 });
      const position = argString(args, 'position', { required: false, max: 20 }) ?? 'last-child';
      if ((page === undefined) === (parent === undefined)) throw new ToolInputError('give exactly one of "page" or "parent_uuid"');
      if (!['last-child', 'first-child', 'after'].includes(position)) throw new ToolInputError('"position" must be last-child, first-child or after');
      if (position === 'after' && !parent) throw new ToolInputError('"after" needs "parent_uuid"');
      const { markdown, blocks } = normalizeOutline(argString(args, 'markdown', { required: true, max: MAX_CHARS }) as string);
      const warnings = await checkContent(markdown, ctx);

      let target: string;
      let title: string;
      let targetUuids: string[];
      const options: Record<string, string | boolean> = { pos: position === 'after' ? 'sibling' : position };
      const tag = (): void => {
        options['update-tags'] = tagsEdn([aiTag]);
      };
      if (page !== undefined) {
        const p = await visiblePage(page, ctx);
        if (!underAiTag([p])) tag();
        options['target-page'] = p.title;
        target = `page "${p.title}", ${position === 'first-child' ? 'at the top' : 'at the end'}`;
        title = `Add ${blocks} block${blocks === 1 ? '' : 's'} to "${p.title}"`;
        targetUuids = p.uuid ? [p.uuid] : [];
      } else {
        const { node, chain } = await visibleBlock(parent as string, ctx);
        options['target-uuid'] = (node.uuid as string).toLowerCase();
        // New children of an AI-tagged block don't need their own tag; siblings check the parent chain.
        if (!underAiTag(position === 'after' ? chain : [node, ...chain])) tag();
        const where = position === 'after' ? 'after' : position === 'first-child' ? 'as first children of' : 'under';
        target = `${where} ${quote(node.title)} on page "${chain.at(-1)?.title ?? '?'}"`;
        title = `Add ${blocks} block${blocks === 1 ? '' : 's'} ${where === 'under' ? 'under a block' : where === 'after' ? 'after a block' : 'into a block'}`;
        targetUuids = node.uuid ? [node.uuid] : [];
      }

      const file = join(deps.runDir, `blocks-${randomUUID()}.md`);
      await writeFile(file, markdown + '\n', { mode: 0o600 });
      const cleanup = (): Promise<void> => unlink(file).catch(() => undefined);
      try {
        const req = { command: ['upsert', 'block'], graph, options: { ...options, 'blocks-file': file } };
        const dry = await run({ ...req, options: { ...req.options, 'dry-run': true } });
        if (!dry.ok) throw new ToolInputError(`Logseq rejected the preview: ${cliMessage(dry)}`);
        const created = (dry.json as { data?: Record<string, unknown> } | null)?.data?.['would-create-pages'];
        if (Array.isArray(created) && created.length > 0) warnings.push(`Will create new page(s): ${created.map(String).join(', ')}`);
        return {
          approval: { tool: 'insert_blocks', title, target, body: { kind: 'blocks', text: markdown }, warnings },
          targetUuids,
          cleanup,
          apply: async () => {
            const r = await run(req);
            if (!r.ok) throw new Error(cliMessage(r));
            const uuids = await uuidsOf(resultIds(r.json));
            return {
              summary: `added ${blocks} block(s)${uuids.length ? `: ${uuids.map((u) => `[id:${u}]`).join(', ')}` : ''}`,
              short: `added ${blocks} block${blocks === 1 ? '' : 's'}`,
              targetUuids: [...targetUuids, ...uuids],
              created: uuids,
            };
          },
        };
      } catch (err) {
        await cleanup();
        throw err;
      }
    }),
  };

  const updateBlocks: ToolDef = {
    name: 'update_blocks',
    kind: 'write',
    description:
      'Propose changing one or more blocks (not their children): new text, tags to add or remove, and properties to set or remove ' +
      '(e.g. translate several lines, drop a tag, set priority or a deadline, mark a task done with status). ' +
      'Tags show at the end of block lines as #tag. Only existing properties can be set; list_properties shows names, types and choices. ' +
      'Put all related edits in ONE call. The user sees before/after for each.',
    inputSchema: {
      type: 'object',
      properties: {
        edits: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: {
            type: 'object',
            properties: {
              uuid: { type: 'string' },
              content: { type: 'string', description: 'The complete new text of the block (omit to keep the text)' },
              add_tags: { type: 'array', items: { type: 'string' }, description: 'Existing tag names to add, without #' },
              remove_tags: { type: 'array', items: { type: 'string' }, description: 'Tag names to remove, without #' },
              set_properties: {
                type: 'object',
                description:
                  'Property name → new value, e.g. {"priority": "High", "deadline": "2026-11-05 14:00", "rating": 4, "done": true, "project": "[[Alpha]]", "status": "Done"}. ' +
                  'Several-value properties take a list: the complete new list. Replaces the current value.',
              },
              remove_properties: { type: 'array', items: { type: 'string' }, description: 'Property names to remove from the block' },
            },
            required: ['uuid'],
            additionalProperties: false,
          },
        },
      },
      required: ['edits'],
      additionalProperties: false,
    },
    label: (a) => (Array.isArray(a.edits) && a.edits.length > 1 ? `proposing ${a.edits.length} edits` : 'proposing an edit'),
    run: withApproval('update_blocks', async (args, ctx, graph) => {
      const raw = args.edits;
      if (!Array.isArray(raw) || raw.length === 0) throw new ToolInputError('"edits" must be a non-empty list of {uuid, content?, add_tags?, remove_tags?, set_properties?, remove_properties?}');
      if (raw.length > 50) throw new ToolInputError('at most 50 edits per call');
      const shieldedTags = deps.policy.protectedTags();
      const shieldedProps = deps.policy.protectedProperties();
      const tagList = (v: unknown, key: string): string[] => {
        if (v === undefined || v === null) return [];
        if (!Array.isArray(v) || v.length > 20) throw new ToolInputError(`"${key}" must be a list of tag names`);
        return v.map((t) => {
          const name = String(t).trim().replace(/^#/, '').replace(/^\[\[(.*)\]\]$/, '$1');
          if (!TAG_NAME_RE.test(name)) throw new ToolInputError(`invalid tag name in "${key}": ${String(t).slice(0, 40)}`);
          if (shieldedTags.has(name.toLowerCase())) throw new ToolInputError(`#${name} is one of the user's privacy tags; only the user may add or remove it.`);
          return name;
        });
      };
      const props = await deps.reader.properties();
      const propFor = (name: string): PropertyInfo => {
        if (typeof name !== 'string' || name.trim() === '' || name.length > 200) throw new ToolInputError('property names must be non-empty strings');
        const info = resolveProperty(props, name);
        if (!info) throw new ToolInputError(`There is no property "${name}". Only existing properties can be used (list_properties shows them); the user can create new ones.`);
        if (shieldedProps.has(info.title.toLowerCase())) throw new ToolInputError(`"${info.title}" is one of the user's privacy settings; only the user may change it.`);
        if (!canSet(info)) {
          const why = info.ident.startsWith('plugin.') ? 'it belongs to a plugin' : info.builtIn ? "it's one of Logseq's own" : `its type (${info.type ?? 'unknown'}) can't be set here`;
          throw new ToolInputError(`"${info.title}" can't be changed by the AI: ${why}.`);
        }
        return info;
      };
      /** One value → EDN for --update-properties, plus how the card shows it. */
      const convert = async (info: PropertyInfo, v: unknown, warnings: string[]): Promise<{ edn: string; shown: string }> => {
        const bad = (want: string): ToolInputError => new ToolInputError(`"${info.title}" needs ${want} (got ${JSON.stringify(v)?.slice(0, 60)})`);
        if (info.choices.length > 0) {
          const s = typeof v === 'string' || typeof v === 'number' ? String(v).trim().toLowerCase() : '';
          const c = info.choices.find((x) => x.title.toLowerCase() === s);
          if (!c) throw bad(`one of: ${info.choices.map((x) => x.title).join(', ')}`);
          // A fixed choice is an existing entity: pass its id (numbers pass the number itself).
          return { edn: info.type === 'number' ? String(Number(c.title)) : String(c.id), shown: c.title };
        }
        switch (info.type) {
          case 'default':
          case 'url': {
            if (typeof v !== 'string' && typeof v !== 'number') throw bad('text');
            const text = String(v).replace(/\s*\n\s*/g, ' ').trim();
            if (text === '' || text.length > 2000) throw bad('1 to 2000 characters of text');
            if (info.type === 'url' && !/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(text)) throw bad('a web address like https://example.com');
            for (const w of await checkContent(text, ctx)) if (!warnings.includes(w)) warnings.push(w);
            for (const pg of await newPagesIn(text)) if (!warnings.includes(`Will create new page: ${pg}`)) warnings.push(`Will create new page: ${pg}`);
            return { edn: ednString(text), shown: text };
          }
          case 'number': {
            const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v.trim()) : Number.NaN;
            if (!Number.isFinite(n) || Math.abs(n) > 1e15) throw bad('a number');
            return { edn: String(n), shown: String(n) };
          }
          case 'checkbox': {
            const b = v === true || v === 'true' ? true : v === false || v === 'false' ? false : null;
            if (b === null) throw bad('true or false');
            return { edn: String(b), shown: String(b) };
          }
          case 'datetime': {
            const ms = typeof v === 'string' ? parseDateTime(v) : null;
            if (ms === null) throw bad('a date like 2026-11-05 or 2026-11-05 14:30');
            return { edn: String(ms), shown: formatDateTime(ms) };
          }
          case 'date': {
            const day = typeof v === 'string' ? parseDay(v.trim().replace(/^\[\[(.*)\]\]$/, '$1')) : null;
            if (day === null) throw bad('a date like 2026-11-05');
            const j = await deps.reader.journalByDay(day);
            if (!j || !visibleTo(deps.policy.evaluate({ node: j, chain: [] }).visibility, ctx.locality)) {
              throw new ToolInputError(`There's no journal page for ${formatJournalDay(day)} yet. "${info.title}" can only point at an existing journal day (the user can open that day in Logseq once).`);
            }
            return { edn: String(j.id), shown: formatJournalDay(day) };
          }
          case 'node': {
            if (typeof v !== 'string') throw bad('a page title or ((block uuid))');
            const text = v.trim();
            const blockRef = /^\(\(([^)]+)\)\)$/.exec(text)?.[1] ?? (isUuid(text) ? text : null);
            if (blockRef !== null) {
              const { node } = await visibleBlock(blockRef, ctx);
              return { edn: String(node.id), shown: `((${node.uuid})) ${quote(node.title, 40)}` };
            }
            const title = text.replace(/^#/, '').replace(/^\[\[(.*)\]\]$/, '$1').trim();
            if (title === '') throw bad('a page title or ((block uuid))');
            const page = await visiblePage(title, ctx);
            return { edn: String(page.id), shown: `[[${page.title}]]` };
          }
          default:
            throw bad('a value type the AI can set');
        }
      };
      /** How many values of this entry link to things the AI can't see (they'd be replaced unseen). */
      const unseenValues = async (e: PropEntry): Promise<number> => {
        const ids = [...new Set(e.values.flatMap((v) => [...(v.target ? [v.target.id] : []), ...v.refs.map((r) => r.id)]))];
        if (ids.length === 0) return 0;
        const found = new Map((await deps.reader.byIds(ids)).map((t) => [t.id, t]));
        const hiddenIds = new Set(ids.filter((id) => {
          const t = found.get(id);
          return !t || !visibleTo(deps.policy.evaluate({ node: t, chain: chainOf(t) }).visibility, ctx.locality);
        }));
        return e.values.filter((v) => (v.target && hiddenIds.has(v.target.id)) || v.refs.some((r) => hiddenIds.has(r.id))).length;
      };

      type PropSet = { info: PropertyInfo; edn: string; shown: string };
      type Item = {
        node: GNode;
        page: string;
        content: string | null;
        add: string[];
        remove: string[];
        set: PropSet[];
        unset: PropertyInfo[];
        /** Properties to clear before setting, so a set replaces instead of adding a second value. */
        clearFirst: string[];
        status: { title: string; token: string } | null;
      };
      const items: Item[] = [];
      const warnings: string[] = [];
      const seen = new Set<string>();
      const known = new Map<string, boolean>();
      let dropped = 0;
      for (const e of raw as unknown[]) {
        if (e === null || typeof e !== 'object' || Array.isArray(e)) throw new ToolInputError('each edit must be an object with "uuid"');
        const ed = e as Record<string, unknown>;
        const uuid = (argString(ed, 'uuid', { required: true, max: 64 }) as string).toLowerCase();
        if (seen.has(uuid)) throw new ToolInputError(`block ${uuid} is edited twice`);
        seen.add(uuid);
        const rawContent = argString(ed, 'content', { required: false, max: 20_000 });
        const content = rawContent === undefined ? null : rawContent.replace(/\r\n?/g, '\n').trim();
        if (content === '') throw new ToolInputError('an edit has empty "content" (use remove_block to delete a block)');
        const add = tagList(ed.add_tags, 'add_tags');
        const remove = tagList(ed.remove_tags, 'remove_tags');
        const setRaw = ed.set_properties;
        if (setRaw !== undefined && setRaw !== null && (typeof setRaw !== 'object' || Array.isArray(setRaw))) {
          throw new ToolInputError('"set_properties" must be an object like {"priority": "High"}');
        }
        const setEntries = Object.entries((setRaw ?? {}) as Record<string, unknown>);
        if (setEntries.length > 20) throw new ToolInputError('at most 20 properties per edit');
        const unsetRaw = ed.remove_properties;
        if (unsetRaw !== undefined && unsetRaw !== null && (!Array.isArray(unsetRaw) || unsetRaw.length > 20)) throw new ToolInputError('"remove_properties" must be a list of property names');
        const { node, chain } = await visibleBlock(uuid, ctx);

        const set: PropSet[] = [];
        let status: Item['status'] = null;
        for (const [name, value] of setEntries) {
          const info = propFor(name);
          if (set.some((x) => x.info.ident === info.ident) || (status && info.ident === STATUS_IDENT)) throw new ToolInputError(`"${info.title}" is set twice in one edit`);
          const list = Array.isArray(value) ? value : [value];
          if (list.length === 0) throw new ToolInputError(`"${info.title}": to clear it, use remove_properties`);
          if (!info.many && list.length > 1) throw new ToolInputError(`"${info.title}" takes one value`);
          if (list.length > 50) throw new ToolInputError(`"${info.title}": at most 50 values`);
          const conv: { edn: string; shown: string }[] = [];
          for (const x of list) {
            const c = await convert(info, x, warnings);
            if (!conv.some((y) => y.edn === c.edn)) conv.push(c);
          }
          if (info.ident === STATUS_IDENT) {
            // Status goes through `upsert task`, which also makes the block a task.
            const title = (conv[0] as { shown: string }).shown;
            status = { title, token: title.toLowerCase().replace(/[ _]+/g, '-') };
            continue;
          }
          set.push({ info, edn: info.many ? `[${conv.map((c) => c.edn).join(' ')}]` : (conv[0] as { edn: string }).edn, shown: conv.map((c) => c.shown).join(', ') });
        }
        const unset: PropertyInfo[] = [];
        for (const name of (unsetRaw ?? []) as unknown[]) {
          const info = propFor(String(name));
          if (info.ident === STATUS_IDENT) throw new ToolInputError('A task keeps a status; set a different one instead (e.g. "Canceled").');
          if (set.some((x) => x.info.ident === info.ident)) throw new ToolInputError(`"${info.title}" is both set and removed`);
          if (node.properties.some((p) => p.info.ident === info.ident) && !unset.includes(info)) unset.push(info);
        }
        const clearFirst = set.filter((x) => node.properties.some((p) => p.info.ident === x.info.ident)).map((x) => x.info.ident);
        for (const ident of [...clearFirst, ...unset.map((u) => u.ident)]) {
          const entry = node.properties.find((p) => p.info.ident === ident) as PropEntry;
          const n = await unseenValues(entry);
          if (n > 0) warnings.push(`Replaces ${n} value(s) of "${entry.info.title}" that the AI can't see.`);
        }
        if (content === null && add.length === 0 && remove.length === 0 && set.length === 0 && unset.length === 0 && status === null) {
          throw new ToolInputError(`edit for ${uuid} changes nothing (give content, tags or properties; the block may not have the properties to remove)`);
        }
        for (const name of add) {
          if (!known.has(name.toLowerCase())) known.set(name.toLowerCase(), await tagExists(graph, name));
          if (!known.get(name.toLowerCase())) throw new ToolInputError(`the tag "${name}" doesn't exist; only existing tags can be added`);
        }
        if (content !== null) {
          // Dropping #private (or another tag your rules use) from the text would remove the tag.
          for (const t of node.tags) {
            if (shieldedTags.has(t.title.toLowerCase()) && mentionsTag(node.title, t.title) && !mentionsTag(content, t.title)) {
              throw new ToolInputError(`The new text drops #${t.title}, one of the user's privacy tags; only the user may remove it. Keep it in the text.`);
            }
          }
          for (const w of await checkContent(content, ctx)) if (!warnings.includes(w)) warnings.push(w);
          // Links the AI couldn't see (shown to it as [hidden]) that the new text would drop.
          const refTargets = await deps.reader.byIds(node.refs.map((r) => r.id));
          const unseen = refTargets.filter((t) => !visibleTo(deps.policy.evaluate({ node: t, chain: chainOf(t) }).visibility, ctx.locality));
          dropped += unseen.filter((t) => !content.includes(t.title) && !(t.uuid && content.includes(t.uuid))).length;
          for (const p of await newPagesIn(content)) if (!warnings.includes(`Will create new page: ${p}`)) warnings.push(`Will create new page: ${p}`);
          // A text edit marks the block as AI-written, unless it already sits under an AI-tagged block.
          if (!underAiTag([node, ...chain]) && !add.some((a) => a.toLowerCase() === aiTag.toLowerCase())) add.push(aiTag);
        }
        items.push({ node, page: chain.at(-1)?.title ?? '?', content, add, remove, set, unset, clearFirst, status });
      }
      if (dropped > 0) warnings.push(`These blocks link to ${dropped} thing(s) the AI can't see; the new text removes ${dropped === 1 ? 'that link' : 'those links'}.`);
      const pages = [...new Set(items.map((i) => i.page))];
      const n = items.length;
      const uuids = items.map((i) => (i.node.uuid as string).toLowerCase());
      const show = (text: string, tags: string[]): string => text + (tags.length ? ` ${tags.map((t) => (/\s/.test(t) ? `#[[${t}]]` : `#${t}`)).join(' ')}` : '');
      const userTags = (node: GNode): string[] => node.tags.filter((t) => !t.ident?.startsWith('logseq.class/')).map((t) => t.title);
      const diffs = items.map((i) => {
        const before = userTags(i.node);
        const removed = new Set(i.remove.map((r) => r.toLowerCase()));
        const after = [...before.filter((t) => !removed.has(t.toLowerCase())), ...i.add.filter((a) => !before.some((b) => b.toLowerCase() === a.toLowerCase()))];
        // Only the properties this edit touches, as "name:: value" lines under the text.
        const touched = [...i.set.map((x) => x.info.ident), ...i.unset.map((u) => u.ident)];
        const beforeProps = i.node.properties.filter((p) => touched.includes(p.info.ident)).map((p) => `${p.info.title}:: ${cardValue(p)}`);
        const afterProps = i.set.map((x) => `${x.info.title}:: ${x.shown}`);
        if (i.status) {
          if (i.node.status) beforeProps.unshift(`status:: ${i.node.status}`);
          afterProps.unshift(`status:: ${i.status.title}`);
        }
        const join = (head: string, lines: string[]): string => [head, ...lines].join('\n');
        return { before: join(show(i.node.title, before), beforeProps), after: join(show(i.content ?? i.node.title, after), afterProps) };
      });
      const anyText = items.some((i) => i.content !== null);
      const anyProps = items.some((i) => i.set.length > 0 || i.unset.length > 0 || i.status !== null);
      const anyTags = items.some((i) => i.add.length > 0 || i.remove.length > 0);
      const what = anyProps && anyTags ? 'tags and properties' : anyProps ? 'properties' : 'tags';
      const title = anyText ? (n === 1 ? 'Edit a block' : `Edit ${n} blocks`) : n === 1 ? `Change ${what} on a block` : `Change ${what} on ${n} blocks`;
      return {
        approval: {
          tool: 'update_blocks',
          title,
          target: n === 1 ? `${quote(items[0]?.node.title ?? '')} on page "${pages[0]}"` : pages.length === 1 ? `on page "${pages[0]}"` : `on ${pages.length} pages`,
          body: { kind: 'diffs', items: diffs },
          warnings,
        },
        targetUuids: uuids,
        ownTargets: uuids,
        apply: async ({ signal, progress }) => {
          let doneCount = 0;
          for (const i of items) {
            if (signal?.aborted) throw new AbortedApply(doneCount, n);
            const uuid = (i.node.uuid as string).toLowerCase();
            const options: Record<string, string> = { uuid };
            if (i.content !== null) options.content = i.content;
            if (i.add.length) options['update-tags'] = tagsEdn(i.add);
            if (i.remove.length) options['remove-tags'] = tagsEdn(i.remove);
            // The CLI removes before it sets, so clearing first makes a set replace the old value.
            const clear = [...new Set([...i.clearFirst, ...i.unset.map((u) => u.ident)])];
            if (clear.length) options['remove-properties'] = `[${clear.map(ednKeyword).join(' ')}]`;
            if (i.set.length) options['update-properties'] = `{${i.set.map((x) => `${ednKeyword(x.info.ident)} ${x.edn}`).join(' ')}}`;
            if (Object.keys(options).length > 1) {
              const r = await run({ command: ['upsert', 'block'], graph, options });
              if (!r.ok) throw new Error(`${doneCount} of ${n} edits applied, then: ${cliMessage(r)}`);
            }
            if (i.status) {
              const r = await run({ command: ['upsert', 'task'], graph, options: { uuid, status: i.status.token } });
              if (!r.ok) throw new Error(`${doneCount} of ${n} edits applied, then (status): ${cliMessage(r)}`);
            }
            doneCount += 1;
            progress?.(doneCount, n);
          }
          return { summary: `edited ${n} block(s): ${uuids.map((u) => `[id:${u}]`).join(', ')}`, short: `edited ${n} block${n === 1 ? '' : 's'}`, targetUuids: uuids };
        },
      };
    }),
  };

  const createTask: ToolDef = {
    name: 'create_task',
    kind: 'write',
    description: 'Propose a new task (#Task) on a page or under a block. The user must approve it.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string' },
        page: { type: 'string', description: 'Title of an existing page' },
        parent_uuid: { type: 'string', description: 'Block uuid to put the task under' },
        status: { type: 'string', description: 'todo (default), doing, done, ...' },
      },
      required: ['content'],
      additionalProperties: false,
    },
    label: () => 'proposing a task',
    run: withApproval('create_task', async (args, ctx, graph) => {
      const content = (argString(args, 'content', { required: true, max: 5000 }) as string).replace(/\s*\n\s*/g, ' ').trim();
      const page = argString(args, 'page', { required: false, max: 300 });
      const parent = argString(args, 'parent_uuid', { required: false, max: 64 });
      const status = (argString(args, 'status', { required: false, max: 30 }) ?? 'todo').toLowerCase();
      if (!/^[a-z-]+$/.test(status)) throw new ToolInputError('"status" must be a word like todo');
      if ((page === undefined) === (parent === undefined)) throw new ToolInputError('give exactly one of "page" or "parent_uuid"');
      const warnings = await checkContent(content, ctx);
      for (const p of await newPagesIn(content)) warnings.push(`Will create new page: ${p}`);
      const options: Record<string, string> = { content, status };
      let target: string;
      let targetUuids: string[];
      let needsTag: boolean;
      if (page !== undefined) {
        const p = await visiblePage(page, ctx);
        options['target-page'] = p.title;
        target = `page "${p.title}", at the end`;
        targetUuids = p.uuid ? [p.uuid] : [];
        needsTag = !underAiTag([p]);
      } else {
        const { node, chain } = await visibleBlock(parent as string, ctx);
        options['target-uuid'] = (node.uuid as string).toLowerCase();
        target = `under ${quote(node.title)} on page "${chain.at(-1)?.title ?? '?'}"`;
        targetUuids = node.uuid ? [node.uuid] : [];
        needsTag = !underAiTag([node, ...chain]);
      }
      return {
        approval: { tool: 'create_task', title: 'Add a task', target, body: { kind: 'text', text: `[${status}] ${content}` }, warnings },
        targetUuids,
        apply: async () => {
          const r = await run({ command: ['upsert', 'task'], graph, options });
          if (!r.ok) throw new Error(cliMessage(r));
          const ids = resultIds(r.json);
          // `upsert task` has no --update-tags, so tag the new task in a second, equally approved step.
          for (const id of needsTag ? ids : []) {
            const t = await run({ command: ['upsert', 'block'], graph, options: { id: String(id), 'update-tags': tagsEdn([aiTag]) } });
            if (!t.ok) throw new Error(`task created, but tagging it failed: ${cliMessage(t)}`);
          }
          const uuids = await uuidsOf(ids);
          return { summary: `created task${uuids.length ? ` [id:${uuids[0]}]` : ''}`, short: 'created a task', targetUuids: [...targetUuids, ...uuids], created: uuids };
        },
      };
    }),
  };

  const createPage: ToolDef = {
    name: 'create_page',
    kind: 'write',
    description: 'Propose a new, empty page. The user must approve it. Then use insert_blocks to fill it.',
    inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false },
    label: (a) => `proposing page "${String(a.title ?? '').slice(0, 40)}"`,
    run: withApproval('create_page', async (args, ctx, graph) => {
      const title = (argString(args, 'title', { required: true, max: 200 }) as string).trim();
      if (title === '' || /[\n\r]/.test(title)) throw new ToolInputError('"title" must be one line');
      if (title.toLowerCase().includes(HIDDEN_MARK)) throw new ToolInputError(`the title contains "${HIDDEN_MARK}"`);
      const cannot = new ToolInputError(`A page named "${title}" can't be created (it may already exist).`);
      if (await deps.reader.pageByTitle(title)) throw cannot;
      // A new page must not land somewhere the user's rules hide (e.g. a denied namespace).
      const synthetic: GNode = {
        id: -1, uuid: null, title, name: title.toLowerCase(), ident: null, pageId: null, parentId: null, order: '',
        journalDay: null, status: null, tags: [], refs: [], props: new Map(), properties: [], createdAt: null, updatedAt: null,
        createdFromProperty: null, parent: null,
      };
      if (!visibleTo(deps.policy.evaluate({ node: synthetic, chain: [] }).visibility, ctx.locality)) throw cannot;
      return {
        approval: { tool: 'create_page', title: 'Create a page', target: 'new page', body: { kind: 'text', text: title }, warnings: [] },
        targetUuids: [],
        apply: async () => {
          const r = await run({ command: ['upsert', 'page'], graph, options: { page: title, 'update-tags': tagsEdn([aiTag]) } });
          if (!r.ok) throw new Error(cliMessage(r));
          const uuids = await uuidsOf(resultIds(r.json));
          return { summary: `created page "${title}"`, short: `created page "${title}"`, targetUuids: uuids, created: uuids };
        },
      };
    }),
  };

  const removeBlock: ToolDef = {
    name: 'remove_block',
    kind: 'write',
    description: 'Propose deleting a block and everything under it. The user sees exactly what would be deleted and must approve it.',
    inputSchema: { type: 'object', properties: { uuid: { type: 'string' } }, required: ['uuid'], additionalProperties: false },
    label: () => 'proposing a deletion',
    run: withApproval('remove_block', async (args, ctx, graph) => {
      const uuid = argString(args, 'uuid', { required: true, max: 64 }) as string;
      const { node, chain } = await visibleBlock(uuid, ctx);
      const page = chain.at(-1) as GNode;
      const all = (await deps.reader.pageBlocks(page.id)).filter((b) => b.createdFromProperty === null);
      const kids = new Map<number, GNode[]>();
      for (const b of all) if (b.parentId !== null) kids.set(b.parentId, [...(kids.get(b.parentId) ?? []), b]);
      for (const list of kids.values()) list.sort((a, b) => (a.order < b.order ? -1 : a.order > b.order ? 1 : 0));
      // The card shows you everything that would go, including blocks the AI can't see.
      const lines = [`- ${node.title}`];
      let total = 1;
      let unseen = 0;
      const subtree: string[] = node.uuid ? [node.uuid.toLowerCase()] : [];
      const walk = (id: number, c: GNode[], depth: number): void => {
        for (const k of kids.get(id) ?? []) {
          total += 1;
          if (k.uuid) subtree.push(k.uuid.toLowerCase());
          if (!visibleTo(deps.policy.evaluate({ node: k, chain: c }).visibility, ctx.locality)) unseen += 1;
          lines.push(`${'  '.repeat(depth)}- ${k.title}`);
          walk(k.id, [k, ...c], depth + 1);
        }
      };
      walk(node.id, [node, ...chain], 1);
      const warnings = unseen > 0 ? [`Also deletes ${unseen} block(s) that this AI can't see.`] : [];
      return {
        approval: { tool: 'remove_block', title: `Delete ${total} block${total === 1 ? '' : 's'}`, target: `on page "${page.title}"`, body: { kind: 'remove', text: lines.join('\n') }, warnings },
        targetUuids: node.uuid ? [node.uuid] : [],
        ownTargets: subtree,
        apply: async () => {
          const r = await run({ command: ['remove', 'block'], graph, options: { uuid: (node.uuid as string).toLowerCase() } });
          if (!r.ok) throw new Error(cliMessage(r));
          return { summary: `deleted ${total} block(s)`, short: `deleted ${total} block${total === 1 ? '' : 's'}`, targetUuids: node.uuid ? [node.uuid] : [] };
        },
      };
    }),
  };

  return [insertBlocks, updateBlocks, createTask, createPage, removeBlock];
}

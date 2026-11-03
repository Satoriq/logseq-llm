import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ApprovalRequest, ApprovalView } from '../approvals.ts';
import type { AuditLog } from '../audit.ts';
import { chainOf, isPage, resultItems } from '../graph/entity.ts';
import type { GNode } from '../graph/entity.ts';
import { GraphError, isUuid } from '../graph/reader.ts';
import type { GraphReader } from '../graph/reader.ts';
import { ACCESS_PROPERTY, visibleTo } from '../policy/policy.ts';
import type { Policy } from '../policy/policy.ts';
import { HIDDEN_MARK } from '../policy/redact.ts';
import type { CliRequest, CliResult } from './cli.ts';
import { argString, ToolInputError } from './registry.ts';
import type { ToolContext, ToolDef, ToolOutput } from './registry.ts';

/**
 * Write tools. Nothing is written until you click Apply on the card in the panel:
 *   check (target visible to this model, graph in writeGraphs, content rules)
 *   → preview (CLI --dry-run where the CLI supports it, otherwise built from a read)
 *   → approval card → Apply runs exactly the previewed command → result back to the model.
 * Everything the AI writes is tagged #AI-GENERATED.
 */

export const AI_TAG = 'AI-GENERATED';
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
};

type Prepared = {
  approval: ApprovalRequest;
  /** Runs the change exactly as previewed. Returns the summary for the model. */
  apply: () => Promise<{ summary: string; targetUuids: string[] }>;
  cleanup?: () => Promise<void>;
  targetUuids: string[];
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

  const ensureTag = async (graph: string): Promise<void> => {
    if (tagChecked) return;
    const r = await deps.run({ command: ['search', 'tag'], graph, options: { content: AI_TAG } });
    if (!r.ok) throw new GraphError('cli', cliMessage(r));
    const found = resultItems(r.json).some((i) => String(i['block/title'] ?? i.title ?? '').toLowerCase() === AI_TAG.toLowerCase());
    if (!found) {
      throw new ToolInputError(`The tag "${AI_TAG}" doesn't exist in this graph yet. The user can create it once with: logseq upsert tag --graph="${graph}" --name=${AI_TAG}`);
    }
    tagChecked = true;
  };

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
      try {
        const { view, decision } = await ctx.approve(prepared.approval);
        const done = (outcome: 'applied' | 'rejected' | 'failed', detail: string, targetUuids: string[]): void => {
          ctx.resolved?.(view as ApprovalView, outcome, detail);
          void deps.audit?.record({ kind: 'write', chatId: ctx.chatId ?? 'cli', ...(ctx.turnId ? { turnId: ctx.turnId } : {}), tool: name, outcome, targetUuids, locality: ctx.locality });
        };
        if (decision.decision !== 'apply') {
          const why =
            decision.reason === 'timeout'
              ? 'No answer from the user within the time limit; nothing was changed.'
              : decision.reason === 'cancelled'
                ? 'The user stopped this turn; nothing was changed.'
                : `The user rejected this change; nothing was changed.${decision.note ? ` Their note: ${quote(decision.note, 500)}` : ''} Don't retry the same change unless they ask.`;
          done('rejected', decision.reason === 'user' ? (decision.note ?? 'rejected') : (decision.reason ?? 'rejected'), prepared.targetUuids);
          return { text: why, sentUuids: [], hiddenCount: 0 };
        }
        try {
          const r = await prepared.apply();
          done('applied', r.summary, r.targetUuids);
          return { text: `Applied: ${r.summary}`, sentUuids: [], hiddenCount: 0 };
        } catch (err) {
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
      const options: Record<string, string | boolean> = { pos: position === 'after' ? 'sibling' : position, 'update-tags': `["${AI_TAG}"]` };
      if (page !== undefined) {
        const p = await visiblePage(page, ctx);
        options['target-page'] = p.title;
        target = `page "${p.title}", ${position === 'first-child' ? 'at the top' : 'at the end'}`;
        title = `Add ${blocks} block${blocks === 1 ? '' : 's'} to "${p.title}"`;
        targetUuids = p.uuid ? [p.uuid] : [];
      } else {
        const { node, chain } = await visibleBlock(parent as string, ctx);
        options['target-uuid'] = (node.uuid as string).toLowerCase();
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
            return { summary: `added ${blocks} block(s)${uuids.length ? `: ${uuids.map((u) => `[id:${u}]`).join(', ')}` : ''}`, targetUuids: [...targetUuids, ...uuids] };
          },
        };
      } catch (err) {
        await cleanup();
        throw err;
      }
    }),
  };

  const updateBlock: ToolDef = {
    name: 'update_block',
    kind: 'write',
    description: "Propose replacing one block's text (not its children). The user sees before/after and must approve it.",
    inputSchema: {
      type: 'object',
      properties: { uuid: { type: 'string' }, content: { type: 'string', description: 'The complete new text of the block' } },
      required: ['uuid', 'content'],
      additionalProperties: false,
    },
    label: () => 'proposing an edit',
    run: withApproval('update_block', async (args, ctx, graph) => {
      const uuid = argString(args, 'uuid', { required: true, max: 64 }) as string;
      const content = (argString(args, 'content', { required: true, max: 20_000 }) as string).replace(/\r\n?/g, '\n').trim();
      if (content === '') throw new ToolInputError('"content" is empty (use remove_block to delete a block)');
      const { node, chain } = await visibleBlock(uuid, ctx);
      const warnings = await checkContent(content, ctx);
      // Links the AI couldn't see (shown to it as [hidden]) that the new text would drop.
      const refTargets = await deps.reader.byIds(node.refs.map((r) => r.id));
      const unseen = refTargets.filter((t) => !visibleTo(deps.policy.evaluate({ node: t, chain: chainOf(t) }).visibility, ctx.locality));
      const dropped = unseen.filter((t) => !content.includes(t.title) && !(t.uuid && content.includes(t.uuid)));
      if (dropped.length > 0) warnings.push(`This block links to ${dropped.length} thing(s) the AI can't see; the new text removes ${dropped.length === 1 ? 'that link' : 'those links'}.`);
      for (const p of await newPagesIn(content)) warnings.push(`Will create new page: ${p}`);
      const req = { command: ['upsert', 'block'], graph, options: { uuid: (node.uuid as string).toLowerCase(), content, 'update-tags': `["${AI_TAG}"]` } };
      return {
        approval: {
          tool: 'update_block',
          title: 'Edit a block',
          target: `${quote(node.title)} on page "${chain.at(-1)?.title ?? '?'}"`,
          body: { kind: 'diff', before: node.title, after: content },
          warnings,
        },
        targetUuids: node.uuid ? [node.uuid] : [],
        apply: async () => {
          const r = await run(req);
          if (!r.ok) throw new Error(cliMessage(r));
          return { summary: `updated [id:${node.uuid}]`, targetUuids: node.uuid ? [node.uuid] : [] };
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
      if (page !== undefined) {
        const p = await visiblePage(page, ctx);
        options['target-page'] = p.title;
        target = `page "${p.title}", at the end`;
        targetUuids = p.uuid ? [p.uuid] : [];
      } else {
        const { node, chain } = await visibleBlock(parent as string, ctx);
        options['target-uuid'] = (node.uuid as string).toLowerCase();
        target = `under ${quote(node.title)} on page "${chain.at(-1)?.title ?? '?'}"`;
        targetUuids = node.uuid ? [node.uuid] : [];
      }
      return {
        approval: { tool: 'create_task', title: 'Add a task', target, body: { kind: 'text', text: `[${status}] ${content}` }, warnings },
        targetUuids,
        apply: async () => {
          const r = await run({ command: ['upsert', 'task'], graph, options });
          if (!r.ok) throw new Error(cliMessage(r));
          const ids = resultIds(r.json);
          // `upsert task` has no --update-tags, so tag the new task in a second, equally approved step.
          for (const id of ids) {
            const t = await run({ command: ['upsert', 'block'], graph, options: { id: String(id), 'update-tags': `["${AI_TAG}"]` } });
            if (!t.ok) throw new Error(`task created, but tagging it failed: ${cliMessage(t)}`);
          }
          const uuids = await uuidsOf(ids);
          return { summary: `created task${uuids.length ? ` [id:${uuids[0]}]` : ''}`, targetUuids: [...targetUuids, ...uuids] };
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
        journalDay: null, status: null, tags: [], refs: [], props: new Map(), createdFromProperty: null, parent: null,
      };
      if (!visibleTo(deps.policy.evaluate({ node: synthetic, chain: [] }).visibility, ctx.locality)) throw cannot;
      return {
        approval: { tool: 'create_page', title: 'Create a page', target: 'new page', body: { kind: 'text', text: title }, warnings: [] },
        targetUuids: [],
        apply: async () => {
          const r = await run({ command: ['upsert', 'page'], graph, options: { page: title, 'update-tags': `["${AI_TAG}"]` } });
          if (!r.ok) throw new Error(cliMessage(r));
          const uuids = await uuidsOf(resultIds(r.json));
          return { summary: `created page "${title}"`, targetUuids: uuids };
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
      const walk = (id: number, c: GNode[], depth: number): void => {
        for (const k of kids.get(id) ?? []) {
          total += 1;
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
        apply: async () => {
          const r = await run({ command: ['remove', 'block'], graph, options: { uuid: (node.uuid as string).toLowerCase() } });
          if (!r.ok) throw new Error(cliMessage(r));
          return { summary: `deleted ${total} block(s)`, targetUuids: node.uuid ? [node.uuid] : [] };
        },
      };
    }),
  };

  return [insertBlocks, updateBlock, createTask, createPage, removeBlock];
}

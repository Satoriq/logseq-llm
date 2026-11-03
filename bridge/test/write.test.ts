import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createRuntime } from '../src/app.ts';
import type { Graph } from '../src/app.ts';
import type { ApprovalRequest } from '../src/approvals.ts';
import { Approvals } from '../src/approvals.ts';
import { loadOrCreateTokens } from '../src/auth.ts';
import { dataPaths, defaultConfig, ensureDataDirs, mergeConfig } from '../src/config.ts';
import { EventLog } from '../src/events.ts';
import type { BridgeEvent } from '../src/events.ts';
import { GraphReader } from '../src/graph/reader.ts';
import { shutdown } from '../src/http/server.ts';
import { Policy } from '../src/policy/policy.ts';
import { parseRules } from '../src/policy/rules.ts';
import { LogseqCli } from '../src/tools/cli.ts';
import { GraphGuard, readTools } from '../src/tools/read.ts';
import type { ToolContext, ToolDef } from '../src/tools/registry.ts';
import { normalizeOutline, writeTools } from '../src/tools/write.ts';
import { FakeLogseq } from './fixtures/fake-graph.ts';

async function setup(opts: { writeGraphs?: string[]; aiTag?: boolean; deny?: string[] } = {}) {
  const fake = new FakeLogseq({ ...(opts.aiTag === false ? { aiTag: false } : {}) });
  const reader = new GraphReader({ run: fake.run, graph: 'AI Sandbox' });
  const policy = new Policy({ deny: parseRules(opts.deny ?? []), allow: [] });
  const runDir = await mkdtemp(join(tmpdir(), 'lsai-w-'));
  const tools = writeTools({ run: fake.run, reader, policy, ensureGraph: async () => {}, graph: 'AI Sandbox', writeGraphs: opts.writeGraphs ?? ['AI Sandbox'], runDir });
  const tool = (n: string): ToolDef => tools.find((t) => t.name === n) as ToolDef;
  return { fake, tool, runDir };
}

/** A ToolContext that records the card and answers it. */
function ctx(answer: 'apply' | 'reject', locality: 'cloud' | 'local' = 'cloud', note?: string) {
  const cards: ApprovalRequest[] = [];
  const outcomes: string[] = [];
  const c: ToolContext = {
    locality,
    chatId: 'c',
    turnId: 't',
    approve: async (req) => {
      cards.push(req);
      return { view: { ...req, id: 'a1', chatId: 'c', turnId: 't', createdAt: 0 }, decision: { decision: answer, reason: 'user', ...(note ? { note } : {}) } };
    },
    resolved: (_v, outcome, detail) => outcomes.push(`${outcome}:${detail}`),
  };
  return { c, cards, outcomes };
}

test('outline normalization', () => {
  assert.deepEqual(normalizeOutline('one\n\ntwo'), { markdown: '- one\n- two', blocks: 2 });
  assert.equal(normalizeOutline('- a\n  - b\n\t- c').blocks, 3);
  assert.throws(() => normalizeOutline('   '), /empty/);
  assert.throws(() => normalizeOutline('  - child first\n- a'), /top-level/);
});

test('writes are off unless the graph is in writeGraphs, and need the AI-GENERATED tag', async () => {
  const off = await setup({ writeGraphs: [] });
  await assert.rejects(off.tool('insert_blocks').run({ page: 'AI Test', markdown: '- x' }, ctx('apply').c), /writeGraphs/);
  const noTag = await setup({ aiTag: false });
  await assert.rejects(noTag.tool('insert_blocks').run({ page: 'AI Test', markdown: '- x' }, ctx('apply').c), /upsert tag --graph="AI Sandbox" --name=AI-GENERATED/);
  assert.equal(off.fake.writes.length + noTag.fake.writes.length, 0);
  // Without an approval channel (e.g. called outside the panel) nothing runs.
  const s = await setup();
  await assert.rejects(s.tool('insert_blocks').run({ page: 'AI Test', markdown: '- x' }, { locality: 'local' }), /need the Logseq AI panel/);
});

test('insert_blocks: dry run → card → Apply runs exactly the previewed command, tagged', async () => {
  const { fake, tool, runDir } = await setup();
  const { c, cards, outcomes } = ctx('apply');
  const out = await tool('insert_blocks').run({ page: 'ai test', markdown: '- Summary of [[Brand New]]\n  - point one' }, c);
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.title, 'Add 2 blocks to "AI Test"');
  assert.equal(cards[0]?.target, 'page "AI Test", at the end');
  assert.deepEqual(cards[0]?.body, { kind: 'blocks', text: '- Summary of [[Brand New]]\n  - point one' });
  assert.ok(cards[0]?.warnings.some((w) => w.includes('Will create new page(s): Brand New')));
  const dry = fake.calls.find((x) => x.command.join(' ') === 'upsert block' && x.options?.['dry-run']);
  const real = fake.writes[0];
  assert.ok(dry && real);
  const { ['dry-run']: _d, ...dryRest } = dry.options ?? {};
  assert.deepEqual(real.options, dryRest, 'apply = the previewed command minus --dry-run');
  assert.equal(real.options?.['update-tags'], '["AI-GENERATED"]');
  assert.match(out.text, /^Applied: added 2 block\(s\): \[id:/);
  assert.equal(outcomes[0], 'applied:added 2 blocks', 'the card gets a short summary, no ids');
  const created = [...fake.byId.values()].filter((e) => e.title.startsWith('Summary of'));
  assert.deepEqual(created[0]?.tags, [300]);
  assert.deepEqual((await readdir(runDir)).filter((f) => f.startsWith('blocks-')), [], 'temp blocks file removed');
});

test('Reject writes nothing and tells the model why', async () => {
  const { fake, tool } = await setup();
  const { c } = ctx('reject', 'cloud', 'not on this page');
  const out = await tool('insert_blocks').run({ page: 'AI Test', markdown: '- nope' }, c);
  assert.equal(fake.writes.length, 0);
  assert.match(out.text, /rejected this change; nothing was changed\. Their note: "not on this page"/);
});

test('content rules: no [hidden], no ai-access, warnings for links and images', async () => {
  const { tool } = await setup();
  await assert.rejects(tool('update_blocks').run({ edits: [{ uuid: '05c4b96b-5012-4826-a902-693efb290e0d', content: 'See [hidden]' }] }, ctx('apply').c), /contains "\[hidden\]"/);
  await assert.rejects(tool('insert_blocks').run({ page: 'AI Test', markdown: '- x\n  ai-access:: cloud-ok' }, ctx('apply').c), /privacy setting/);
  const { c, cards } = ctx('reject');
  await tool('insert_blocks').run({ page: 'AI Test', markdown: '- ![x](https://evil.example/p.png) see https://example.com' }, c);
  assert.ok(cards[0]?.warnings.some((w) => w.includes('image link')));
  assert.ok(cards[0]?.warnings.some((w) => w.includes('web link')));
});

test('a cloud model cannot write to blocks it cannot see', async () => {
  const { tool, fake } = await setup();
  await assert.rejects(tool('update_blocks').run({ edits: [{ uuid: 'ef13d15c-eb66-4eb1-ab54-edbae48baa8e', content: 'x' }] }, ctx('apply', 'cloud').c), /No block with id/);
  await assert.rejects(tool('insert_blocks').run({ parent_uuid: '44402c58-25a1-4806-9f1f-f4771a8e2d63', markdown: '- x' }, ctx('apply', 'cloud').c), /No block with id/);
  // A local model may.
  const { c } = ctx('apply', 'local');
  assert.match((await tool('update_blocks').run({ edits: [{ uuid: 'ef13d15c-eb66-4eb1-ab54-edbae48baa8e', content: 'Edited secret #private' }] }, c)).text, /^Applied/);
  assert.equal(fake.writes.length, 1);
});

test('update_blocks: before/after card and a warning when hidden links would be dropped', async () => {
  const { tool } = await setup({ deny: ['page:AI Test 2'] });
  const { c, cards } = ctx('apply');
  const out = await tool('update_blocks').run({ edits: [{ uuid: '05c4b96b-5012-4826-a902-693efb290e0d', content: 'See the other page' }] }, c);
  assert.deepEqual(cards[0]?.body, { kind: 'diffs', items: [{ before: 'See [[AI Test 2]]', after: 'See the other page' }] });
  assert.ok(cards[0]?.warnings.some((w) => w.includes("link to 1 thing(s) the AI can't see")));
  assert.match(out.text, /^Applied: edited 1 block/);
});

test('remove_block shows everything that would go, including blocks hidden from the AI', async () => {
  const { tool, fake } = await setup();
  const { c, cards } = ctx('apply');
  const out = await tool('remove_block').run({ uuid: '00000000-0000-4000-8000-000000000212' }, c);
  assert.equal(cards[0]?.title, 'Delete 2 blocks');
  assert.match((cards[0]?.body as { text: string }).text, /Private child/);
  assert.ok(cards[0]?.warnings.some((w) => w.includes("1 block(s) that this AI can't see")));
  assert.match(out.text, /^Applied: deleted 2 block/);
  assert.equal(fake.byId.has(213), false);
});

test('create_page refuses existing and denied names the same way; create_task tags the task', async () => {
  const { tool, fake } = await setup({ deny: ['namespace:Private/'] });
  const exists = tool('create_page').run({ title: 'AI Test' }, ctx('apply').c);
  const denied = tool('create_page').run({ title: 'Private/Diary' }, ctx('apply').c);
  await assert.rejects(exists, /can't be created \(it may already exist\)/);
  await assert.rejects(denied, /can't be created \(it may already exist\)/);
  assert.match((await tool('create_page').run({ title: 'Fresh page' }, ctx('apply').c)).text, /^Applied: created page "Fresh page"/);
  const task = await tool('create_task').run({ content: 'Buy pears', page: 'AI Test', status: 'todo' }, ctx('apply').c);
  assert.match(task.text, /^Applied: created task/);
  const t = [...fake.byId.values()].find((e) => e.title === 'Buy pears');
  assert.deepEqual(t?.tags, [300], 'tagged in the second step');
});

test('approvals: timeout and cancel reject; unknown ids are refused', async () => {
  const logs = new Map<string, EventLog>();
  const events = (id: string): EventLog => {
    let l = logs.get(id);
    if (!l) logs.set(id, (l = new EventLog('e')));
    return l;
  };
  const a = new Approvals({ events, timeoutMs: 50, requireUi: false });
  const req: ApprovalRequest = { tool: 'x', title: 't', target: 'g', body: { kind: 'text', text: 'b' }, warnings: [] };
  assert.equal((await a.request('c1', 't1', req)).decision.reason, 'timeout');
  const p = a.request('c2', 't2', req);
  assert.equal(a.pending('c2').length, 1);
  a.rejectAll('c2', 'cancelled');
  assert.equal((await p).decision.reason, 'cancelled');
  assert.equal(a.decide('00000000-0000-4000-8000-000000000000', 'apply'), false);
  assert.equal(events('c2').since(0).events[0]?.type, 'approval.request');
});

test('approvals fail fast when no card-capable panel is attached; auto requests never wait', async () => {
  const logs = new Map<string, EventLog>();
  const events = (id: string): EventLog => {
    let l = logs.get(id);
    if (!l) logs.set(id, (l = new EventLog('e')));
    return l;
  };
  const a = new Approvals({ events, timeoutMs: 60_000 });
  const req: ApprovalRequest = { tool: 'x', title: 't', target: 'g', body: { kind: 'text', text: 'b' }, warnings: [] };
  const t0 = Date.now();
  assert.equal((await a.request('c', 't', req)).decision.reason, 'no-panel');
  assert.ok(Date.now() - t0 < 1000);
  assert.match(String(events('c').since(0).events.at(-1)?.data.message), /no Logseq AI panel/);
  assert.equal((await a.request('c', 't', { ...req, auto: true })).decision.reason, 'auto');
  const detach = a.uiAttach('c');
  const pending = a.request('c', 't', req);
  assert.equal(a.pending('c').length, 1);
  a.decide(a.pending('c')[0]?.id as string, 'apply');
  assert.equal((await pending).decision.decision, 'apply');
  detach();
  assert.equal(a.hasUi('c'), false);
  a.uiSeen('c');
  assert.equal(a.hasUi('c'), true, 'a recent long-poll counts');
});

test('autoApply "additions": plain additions skip the card, anything with a warning or an edit does not', async () => {
  const fake = new FakeLogseq();
  const reader = new GraphReader({ run: fake.run, graph: 'AI Sandbox' });
  const policy = new Policy({ deny: [], allow: [] });
  const runDir = await mkdtemp(join(tmpdir(), 'lsai-wa-'));
  const tools = writeTools({ run: fake.run, reader, policy, ensureGraph: async () => {}, graph: 'AI Sandbox', writeGraphs: ['AI Sandbox'], runDir, autoApply: 'additions' });
  const tool = (n: string): ToolDef => tools.find((t) => t.name === n) as ToolDef;
  const seen: { auto: boolean; title: string }[] = [];
  // Like the real Approvals: auto → apply; otherwise the user rejects here.
  const c: ToolContext = {
    locality: 'cloud',
    chatId: 'c',
    turnId: 't',
    approve: async (req) => {
      seen.push({ auto: req.auto === true, title: req.title });
      return { view: { ...req, id: 'x', chatId: 'c', turnId: 't', createdAt: 0 }, decision: req.auto ? { decision: 'apply', reason: 'auto' } : { decision: 'reject', reason: 'user' } };
    },
  };
  assert.match((await tool('insert_blocks').run({ page: 'AI Test', markdown: '- a plain note' }, c)).text, /^Applied/);
  assert.match((await tool('create_task').run({ content: 'Buy pears', page: 'AI Test' }, c)).text, /^Applied/);
  assert.match((await tool('insert_blocks').run({ page: 'AI Test', markdown: '- see https://example.com' }, c)).text, /rejected/, 'a web link → manual card');
  assert.match((await tool('insert_blocks').run({ page: 'AI Test', markdown: '- about [[Brand New]]' }, c)).text, /rejected/, 'a new page → manual card');
  assert.match((await tool('update_blocks').run({ edits: [{ uuid: 'a558ac4e-ae05-43f3-af22-f167c5f56975', content: 'Apples are green' }] }, c)).text, /rejected/, 'edits always need Apply');
  assert.match((await tool('remove_block').run({ uuid: '54f76cdd-307a-436e-9716-f129841c97e6' }, c)).text, /rejected/, 'deletes always need Apply');
  assert.deepEqual(seen.map((x) => x.auto), [true, true, false, false, false, false]);
  assert.equal(fake.writes.length, 3, 'insert + task + its tag');
});

test('end to end: claude proposes a write, the panel approves it over HTTP', async () => {
  const paths = dataPaths(await mkdtemp(join(tmpdir(), 'lsai-we-')));
  await ensureDataDirs(paths);
  const tokens = await loadOrCreateTokens(paths.tokens);
  const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
  const config = mergeConfig(defaultConfig(), { graph: 'AI Sandbox', writeGraphs: ['AI Sandbox'], claudeBin: FAKE_CLAUDE, logseqBin: FAKE_CLAUDE });
  const fake = new FakeLogseq();
  const reader = new GraphReader({ run: fake.run, graph: 'AI Sandbox' });
  const policy = new Policy({ deny: [], allow: [] });
  const guard = new GraphGuard({ graph: 'AI Sandbox', serverList: fake.serverList });
  const ensureGraph = (): Promise<void> => guard.ensure();
  const graph: Graph = {
    cli: new LogseqCli({ bin: FAKE_CLAUDE, writeGraphs: [], timeoutMs: 1000, concurrency: 1 }),
    reader,
    policy,
    guard,
    tools: [...readTools({ reader, policy, ensureGraph }), ...writeTools({ run: fake.run, reader, policy, ensureGraph, graph: 'AI Sandbox', writeGraphs: ['AI Sandbox'], runDir: paths.run })],
  };
  const rt = await createRuntime({ config, paths, tokens, graph });
  const port = await rt.listen(0);
  try {
    assert.ok(rt.mcp.toolNames().includes('insert_blocks'));
    const chat = await rt.store.create('w');
    const events: BridgeEvent[] = [];
    rt.turns.eventLog(chat.id).subscribe((e) => {
      events.push(e);
      if (e.type === 'approval.request') {
        // The panel's Apply button:
        const body = JSON.stringify({ decision: 'apply' });
        const r = request({ host: '127.0.0.1', port, method: 'POST', path: `/v1/approvals/${String(e.data.id)}`, headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${tokens.plugin}`, 'content-type': 'application/json' } });
        r.end(body);
      }
    });
    const detach = rt.approvals.uiAttach(chat.id); // as the panel's event stream (caps=approvals) would
    const { done } = await rt.turns.start(chat.id, { text: 'FAKE:write', providerId: 'claude', model: 'sonnet', effort: 'auto', contextUuids: [] });
    await done;
    const text = events.filter((e) => e.type === 'text.delta').map((e) => String(e.data.text)).join('');
    assert.match(text, /write="Applied: added 2 block\(s\)/);
    const types = events.map((e) => e.type);
    assert.ok(types.includes('tool.waiting'));
    assert.ok(types.indexOf('approval.request') < types.indexOf('approval.resolved'));
    assert.equal(events.find((e) => e.type === 'approval.resolved')?.data.outcome, 'applied');
    assert.equal(fake.writes.length, 1);
    assert.equal(rt.approvals.pending(chat.id).length, 0);
    detach();
  } finally {
    await shutdown(rt.server);
  }
});

test('autoApply "own": edits and deletes of blocks the AI added in this chat skip the card; yours do not', async () => {
  const fake = new FakeLogseq();
  const reader = new GraphReader({ run: fake.run, graph: 'AI Sandbox' });
  const policy = new Policy({ deny: [], allow: [] });
  const runDir = await mkdtemp(join(tmpdir(), 'lsai-wo-'));
  const owned = new Map<string, Set<string>>();
  const own = {
    list: async (chat: string) => owned.get(chat) ?? new Set<string>(),
    add: async (chat: string, uuids: string[]) => {
      const set = owned.get(chat) ?? new Set<string>();
      for (const u of uuids) set.add(u.toLowerCase());
      owned.set(chat, set);
    },
  };
  const tools = writeTools({ run: fake.run, reader, policy, ensureGraph: async () => {}, graph: 'AI Sandbox', writeGraphs: ['AI Sandbox'], runDir, autoApply: 'own', own });
  const tool = (n: string): ToolDef => tools.find((t) => t.name === n) as ToolDef;
  const autos: boolean[] = [];
  const mk = (chatId: string): ToolContext => ({
    locality: 'cloud',
    chatId,
    turnId: 't',
    approve: async (req) => {
      autos.push(req.auto === true);
      return { view: { ...req, id: 'x', chatId, turnId: 't', createdAt: 0 }, decision: req.auto ? { decision: 'apply', reason: 'auto' } : { decision: 'reject', reason: 'user' } };
    },
  });
  const c = mk('chat-1');
  const added = await tool('insert_blocks').run({ page: 'AI Test', markdown: '- Poem title\n  - line one\n  - line two' }, c);
  const ids = [...added.text.matchAll(/\[id:([0-9a-f-]{36})\]/g)].map((m) => m[1] as string);
  assert.equal(ids.length, 3);
  // Translate the AI's own lines in one call: auto.
  const edited = await tool('update_blocks').run({ edits: ids.slice(1).map((uuid, i) => ({ uuid, content: `translated ${i}` })) }, c);
  assert.match(edited.text, /^Applied: edited 2 block/);
  // Mixed with one of your blocks: card.
  assert.match((await tool('update_blocks').run({ edits: [{ uuid: ids[1] as string, content: 'x' }, { uuid: 'a558ac4e-ae05-43f3-af22-f167c5f56975', content: 'y' }] }, c)).text, /rejected/);
  // Another chat doesn't own them: card.
  assert.match((await tool('update_blocks').run({ edits: [{ uuid: ids[1] as string, content: 'z' }] }, mk('chat-2'))).text, /rejected/);
  // Delete the AI's whole poem (all own): auto.
  assert.match((await tool('remove_block').run({ uuid: ids[0] as string }, c)).text, /^Applied: deleted 3 block/);
  // Deleting a block of yours: card.
  assert.match((await tool('remove_block').run({ uuid: '54f76cdd-307a-436e-9716-f129841c97e6' }, c)).text, /rejected/);
  assert.deepEqual(autos, [true, true, false, false, true, false]);
});

test('"Apply all": the rest of this answer is applied without asking; another answer still asks', async () => {
  const logs = new Map<string, EventLog>();
  const events = (id: string): EventLog => {
    let l = logs.get(id);
    if (!l) logs.set(id, (l = new EventLog('e')));
    return l;
  };
  const a = new Approvals({ events, requireUi: false });
  const req: ApprovalRequest = { tool: 'update_blocks', title: 't', target: 'g', body: { kind: 'text', text: 'b' }, warnings: ['a warning'] };
  const first = a.request('c', 'turn-1', req);
  a.decide(a.pending('c')[0]?.id as string, 'apply-all');
  assert.equal((await first).decision.decision, 'apply');
  const second = await a.request('c', 'turn-1', req);
  assert.equal(second.decision.reason, 'auto', 'same answer: no card wait');
  assert.equal(second.view.auto, true);
  const other = a.request('c', 'turn-2', req);
  assert.equal(a.pending('c').length, 1, 'a new answer asks again');
  a.rejectAll('c', 'cancelled');
  assert.equal((await other).decision.reason, 'cancelled');
  assert.equal(a.isTrusted('turn-1'), false, 'turn end forgets "Apply all"');
});

test('auto edits wait a grace period and can be aborted in it', async () => {
  const events = (() => {
    const l = new EventLog('e');
    return () => l;
  })();
  const a = new Approvals({ events, requireUi: false });
  const req: ApprovalRequest = { tool: 'remove_block', title: 't', target: 'g', body: { kind: 'text', text: 'b' }, warnings: [], auto: true, graceMs: 300 };
  const p = a.request('c', 't', req);
  const id = events().since(0).events.find((e) => e.type === 'approval.request')?.data.id as string;
  assert.equal(a.decide(id, 'abort'), true);
  assert.equal((await p).decision.reason, 'aborted');
  const t0 = Date.now();
  const q = await a.request('c', 't', { ...req, graceMs: 60 });
  assert.ok(Date.now() - t0 >= 50, 'waited the grace period');
  assert.equal(q.decision.decision, 'apply');
  assert.ok(q.decision.signal, 'apply comes with an abort signal for the running phase');
});

test('Abort during a batch stops the remaining edits and tells the model how many went in', async () => {
  const { fake, tool } = await setup();
  const ac = new AbortController();
  const progress: string[] = [];
  const c: ToolContext = {
    locality: 'local',
    chatId: 'c',
    turnId: 't',
    approve: async (req) => ({ view: { ...req, id: 'x', chatId: 'c', turnId: 't', createdAt: 0 }, decision: { decision: 'apply', reason: 'user', signal: ac.signal } }),
    progress: (_v, done, total) => {
      progress.push(`${done}/${total}`);
      if (done === 1) ac.abort(); // the user clicks Abort after the first edit
    },
    resolved: (_v, outcome, detail) => progress.push(`${outcome}:${detail}`),
  };
  const out = await tool('update_blocks').run(
    {
      edits: [
        { uuid: 'a558ac4e-ae05-43f3-af22-f167c5f56975', content: 'one' },
        { uuid: '54f76cdd-307a-436e-9716-f129841c97e6', content: 'two' },
        { uuid: '05c4b96b-5012-4826-a902-693efb290e0d', content: 'three' },
      ],
    },
    c,
  );
  assert.match(out.text, /aborted this change: 1 of 3 edits had been applied/);
  assert.equal(fake.writes.length, 1);
  assert.deepEqual(progress, ['1/3', 'aborted:1 of 3 applied']);
});

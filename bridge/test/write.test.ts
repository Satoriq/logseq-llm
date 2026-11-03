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
  assert.match(outcomes[0] ?? '', /^applied:/);
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
  await assert.rejects(tool('update_block').run({ uuid: '05c4b96b-5012-4826-a902-693efb290e0d', content: 'See [hidden]' }, ctx('apply').c), /contains "\[hidden\]"/);
  await assert.rejects(tool('insert_blocks').run({ page: 'AI Test', markdown: '- x\n  ai-access:: cloud-ok' }, ctx('apply').c), /privacy setting/);
  const { c, cards } = ctx('reject');
  await tool('insert_blocks').run({ page: 'AI Test', markdown: '- ![x](https://evil.example/p.png) see https://example.com' }, c);
  assert.ok(cards[0]?.warnings.some((w) => w.includes('image link')));
  assert.ok(cards[0]?.warnings.some((w) => w.includes('web link')));
});

test('a cloud model cannot write to blocks it cannot see', async () => {
  const { tool, fake } = await setup();
  await assert.rejects(tool('update_block').run({ uuid: 'ef13d15c-eb66-4eb1-ab54-edbae48baa8e', content: 'x' }, ctx('apply', 'cloud').c), /No block with id/);
  await assert.rejects(tool('insert_blocks').run({ parent_uuid: '44402c58-25a1-4806-9f1f-f4771a8e2d63', markdown: '- x' }, ctx('apply', 'cloud').c), /No block with id/);
  // A local model may.
  const { c } = ctx('apply', 'local');
  assert.match((await tool('update_block').run({ uuid: 'ef13d15c-eb66-4eb1-ab54-edbae48baa8e', content: 'Edited secret #private' }, c)).text, /^Applied/);
  assert.equal(fake.writes.length, 1);
});

test('update_block: before/after card and a warning when hidden links would be dropped', async () => {
  const { tool } = await setup({ deny: ['page:AI Test 2'] });
  const { c, cards } = ctx('apply');
  const out = await tool('update_block').run({ uuid: '05c4b96b-5012-4826-a902-693efb290e0d', content: 'See the other page' }, c);
  assert.deepEqual(cards[0]?.body, { kind: 'diff', before: 'See [[AI Test 2]]', after: 'See the other page' });
  assert.ok(cards[0]?.warnings.some((w) => w.includes("links to 1 thing(s) the AI can't see")));
  assert.match(out.text, /^Applied: updated/);
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
  const a = new Approvals({ events, timeoutMs: 50 });
  const req: ApprovalRequest = { tool: 'x', title: 't', target: 'g', body: { kind: 'text', text: 'b' }, warnings: [] };
  assert.equal((await a.request('c1', 't1', req)).decision.reason, 'timeout');
  const p = a.request('c2', 't2', req);
  assert.equal(a.pending('c2').length, 1);
  a.rejectAll('c2', 'cancelled');
  assert.equal((await p).decision.reason, 'cancelled');
  assert.equal(a.decide('00000000-0000-4000-8000-000000000000', 'apply'), false);
  assert.equal(events('c2').since(0).events[0]?.type, 'approval.request');
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
  } finally {
    await shutdown(rt.server);
  }
});

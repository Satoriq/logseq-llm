import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultConfig, mergeConfig } from '../src/config.ts';
import { GraphReader } from '../src/graph/reader.ts';
import { Policy } from '../src/policy/policy.ts';
import { redactRefs } from '../src/policy/redact.ts';
import { parseRule, parseRules, RuleError } from '../src/policy/rules.ts';
import { GraphGuard, readTools } from '../src/tools/read.ts';
import type { ToolDef } from '../src/tools/registry.ts';
import { FakeLogseq } from './fixtures/fake-graph.ts';

function setup(opts: { deny?: string[]; allow?: string[]; owner?: string } = {}) {
  const fake = new FakeLogseq({ ...(opts.owner ? { owner: opts.owner } : {}) });
  const reader = new GraphReader({ run: fake.run, graph: 'AI Sandbox' });
  const policy = new Policy({ deny: parseRules(opts.deny ?? []), allow: parseRules(opts.allow ?? []) });
  const guard = new GraphGuard({ graph: 'AI Sandbox', serverList: fake.serverList });
  const tools = readTools({ reader, policy, ensureGraph: () => guard.ensure() });
  const tool = (name: string): ToolDef => {
    const t = tools.find((x) => x.name === name);
    if (!t) throw new Error(name);
    return t;
  };
  return { fake, tool };
}

test('rules: parsing and errors', () => {
  assert.deepEqual(parseRule('tag:#Private'), { kind: 'tag', tag: 'private', source: 'tag:#Private' });
  assert.deepEqual(parseRule('journal:..2025-12-31'), { kind: 'journal', from: null, to: 20251231, source: 'journal:..2025-12-31' });
  assert.deepEqual(parseRule('property:Client=ACME'), { kind: 'property', name: 'client', value: 'acme', source: 'property:Client=ACME' });
  assert.equal(parseRule('namespace:Work/').kind, 'namespace');
  for (const bad of ['tag', 'tag:', 'colour:red', 'journal:2026-02-30..', 'journal:..', 'journal:2026-05-01..2026-01-01', 'property:x=']) {
    assert.throws(() => parseRule(bad), RuleError, bad);
  }
});

test('config refuses to load with a broken rule (never silently skip a deny)', () => {
  assert.throws(() => mergeConfig(defaultConfig(), { policy: { deny: ['tag:private', 'pagee:Diary'] } }), /unknown rule type/);
  assert.equal(mergeConfig(defaultConfig(), { policy: { deny: ['page:Diary'] } }).policy.deny.length, 1);
});

test('redaction of refs to hidden entities', () => {
  const ref = { id: 1, title: 'Secret Project', uuid: '11111111-1111-4111-8111-111111111111', isPage: true };
  const r = redactRefs('See [[Secret Project]], #[[secret project]] and ((11111111-1111-4111-8111-111111111111))', [ref]);
  assert.equal(r.text, 'See [hidden], [hidden] and [hidden]');
  assert.equal(r.count, 3);
  const tag = redactRefs('tagged #diary and #diary-2', [{ id: 2, title: 'diary', uuid: null, isPage: true }]);
  assert.equal(tag.text, 'tagged [hidden] and #diary-2');
});

test('get_page as cloud: #private and ai-access blocks are gone, with their children', async () => {
  const { tool } = setup();
  const out = await tool('get_page').run({ title: 'ai test' }, { locality: 'cloud' });
  assert.match(out.text, /Apples are red/);
  assert.match(out.text, /A child block about apples/);
  assert.match(out.text, /See \[\[AI Test 2\]\]/);
  for (const hidden of ['secret', 'Child of secret', 'Local only note', 'Totally secret', 'local-only']) {
    assert.ok(!out.text.includes(hidden), `cloud view leaked "${hidden}":\n${out.text}`);
  }
  // #private block + its child, the local-only block, the ai-access:none block
  assert.equal(out.hiddenCount, 4);
  assert.ok(out.sentUuids.includes('a558ac4e-ae05-43f3-af22-f167c5f56975'));
  assert.ok(!out.sentUuids.includes('ef13d15c-eb66-4eb1-ab54-edbae48baa8e'));
  // Child is indented under its parent, ids are shown.
  assert.match(out.text, /\n {2}- A child block about apples {2}\[id:54f76cdd-307a-436e-9716-f129841c97e6\]/);
});

test('get_page as local: #private and local-only are visible, ai-access:none is not', async () => {
  const { tool } = setup();
  const out = await tool('get_page').run({ title: 'AI Test' }, { locality: 'local' });
  assert.match(out.text, /This one is secret #private/);
  assert.match(out.text, /Child of secret/);
  assert.match(out.text, /Local only note/);
  assert.ok(!out.text.includes('Totally secret'));
  assert.ok(!out.text.includes('ai-access::'), 'the access mark itself is not shown');
  assert.equal(out.hiddenCount, 1);
});

test('deny page: the page answers like a missing page, refs to it are redacted', async () => {
  const { tool } = setup({ deny: ['page:AI Test 2'] });
  const missing = await tool('get_page').run({ title: 'AI Test 2' }, { locality: 'local' });
  const nonexistent = await tool('get_page').run({ title: 'Nope' }, { locality: 'local' });
  assert.equal(missing.text.replace('AI Test 2', 'X'), nonexistent.text.replace('Nope', 'X'));
  const page = await tool('get_page').run({ title: 'AI Test' }, { locality: 'cloud' });
  assert.match(page.text, /See \[hidden\]/);
  const tasks = await tool('list_tasks').run({}, { locality: 'local' });
  assert.ok(!tasks.text.includes('Buy apples'), 'blocks on a denied page are denied');
});

test('allow list: only matching pages are visible', async () => {
  const { tool } = setup({ allow: ['page:AI Test 2'] });
  const hits = await tool('search_blocks').run({ query: 'apples' }, { locality: 'local' });
  assert.match(hits.text, /Buy apples/);
  assert.ok(!hits.text.includes('Apples are red'));
  assert.ok(!hits.text.includes('Journal apples entry'));
});

test('deny by tag, journal range and property', async () => {
  const tagged = setup({ deny: ['tag:private'] });
  const t = await tagged.tool('get_page').run({ title: 'AI Test' }, { locality: 'local' });
  assert.ok(!t.text.includes('secret') && !t.text.includes('Child of secret'));

  const journal = setup({ deny: ['journal:2026-11-01..2026-11-30'] });
  const j = await journal.tool('search_blocks').run({ query: 'apples' }, { locality: 'local' });
  assert.ok(!j.text.includes('Journal apples entry'));
  assert.match(j.text, /Apples are red/);

  const prop = setup({ deny: ['property:ai-access=local-only'] });
  const p = await prop.tool('get_page').run({ title: 'AI Test' }, { locality: 'local' });
  assert.ok(!p.text.includes('Local only note'));
});

test('search never reveals hidden hits to the model', async () => {
  const { tool } = setup();
  const cloud = await tool('search_blocks').run({ query: 'secret' }, { locality: 'cloud' });
  assert.equal(cloud.text, 'No matching blocks.');
  assert.ok(cloud.hiddenCount >= 2);
  const local = await tool('search_blocks').run({ query: 'secret' }, { locality: 'local' });
  assert.match(local.text, /This one is secret/);
  assert.match(local.text, /Child of secret/);
  assert.ok(!local.text.includes('Totally secret'));
  const apples = await tool('search_blocks').run({ query: 'apples' }, { locality: 'cloud' });
  assert.match(apples.text, /\(page "AI Test"\)/);
});

test('get_block: hidden block looks missing; visible block shows page and children', async () => {
  const { tool } = setup();
  const hidden = await tool('get_block').run({ uuid: 'ef13d15c-eb66-4eb1-ab54-edbae48baa8e' }, { locality: 'cloud' });
  assert.match(hidden.text, /^No block with id/);
  const ok = await tool('get_block').run({ uuid: 'a558ac4e-ae05-43f3-af22-f167c5f56975' }, { locality: 'cloud' });
  assert.match(ok.text, /On page "AI Test"/);
  assert.match(ok.text, /A child block about apples/);
  const valueBlock = await tool('get_block').run({ uuid: '6aea4fc6-78b0-4d91-920b-1a99580f503f' }, { locality: 'local' });
  assert.match(valueBlock.text, /^No block with id/, 'property value blocks are not content');
  await assert.rejects(tool('get_block').run({ uuid: 'not-a-uuid' }, { locality: 'local' }), /must be a block uuid/);
});

test('tasks, pages and backlinks are filtered too', async () => {
  const { tool } = setup();
  assert.match((await tool('list_tasks').run({ status: 'todo' }, { locality: 'cloud' })).text, /Buy apples.*status: Todo/);
  await assert.rejects(tool('list_tasks').run({ status: 'todo; drop' }, { locality: 'cloud' }), /must be a word/);
  const pages = await tool('list_pages').run({}, { locality: 'cloud' });
  assert.match(pages.text, /page "AI Test 2"/);
  const links = await tool('get_backlinks').run({ title: 'AI Test 2' }, { locality: 'cloud' });
  assert.match(links.text, /See \[\[AI Test 2\]\]/);
});

test('model/user text never goes into the query text, only into --inputs', async () => {
  const { fake, tool } = setup();
  const evil = 'x"] :where [?e :block/uuid] ["';
  await tool('get_page').run({ title: evil }, { locality: 'local' });
  const q = fake.calls.find((c) => String(c.options?.query ?? '').includes(':block/name ?name'));
  assert.ok(q);
  assert.ok(!String(q.options?.query).includes(evil));
  assert.equal(JSON.parse(String(q.options?.inputs))[0], evil.toLowerCase());
});

test('guard: refuses unless the app serves the graph', async () => {
  const notOpen = setup({ owner: 'cli' });
  await assert.rejects(notOpen.tool('get_page').run({ title: 'AI Test' }, { locality: 'local' }), /Open the graph "AI Sandbox" in Logseq first/);
  assert.equal(notOpen.fake.calls.length, 0, 'no graph query ran');
  const guard = new GraphGuard({ graph: null, serverList: new FakeLogseq().serverList });
  await assert.rejects(guard.ensure(), /Set "graph"/);
});

test('fail closed: a block whose page is missing is hidden', async () => {
  const fake = new FakeLogseq();
  fake.byId.delete(197); // "Buy apples" now points at a page that doesn't exist
  const reader = new GraphReader({ run: fake.run, graph: 'AI Sandbox' });
  const tools = readTools({ reader, policy: new Policy({ deny: [], allow: [] }), ensureGraph: async () => {} });
  const out = await tools.find((t) => t.name === 'search_blocks')!.run({ query: 'buy' }, { locality: 'local' });
  assert.equal(out.text, 'No matching blocks.');
  assert.equal(out.hiddenCount, 1);
});

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ApprovalRequest } from '../src/approvals.ts';
import { mergeConfig, defaultConfig } from '../src/config.ts';
import { GraphReader } from '../src/graph/reader.ts';
import { Policy } from '../src/policy/policy.ts';
import { parseRules } from '../src/policy/rules.ts';
import { parseDateTime, parseDay } from '../src/tools/properties.ts';
import { readTools } from '../src/tools/read.ts';
import type { PropertyMode } from '../src/tools/read.ts';
import type { ToolContext, ToolDef } from '../src/tools/registry.ts';
import { writeTools } from '../src/tools/write.ts';
import { DEADLINE_MS, FakeLogseq, P, parseEdn } from './fixtures/fake-graph.ts';

const BLOCK = '00000000-0000-4000-8000-000000000238';

async function setup(opts: { mode?: PropertyMode; deny?: string[] } = {}) {
  const fake = new FakeLogseq();
  const reader = new GraphReader({ run: fake.run, graph: 'AI Sandbox' });
  const policy = new Policy({ deny: parseRules(opts.deny ?? []), allow: [] });
  const ensureGraph = async (): Promise<void> => {};
  const runDir = await mkdtemp(join(tmpdir(), 'lsai-p-'));
  const tools = [
    ...readTools({ reader, policy, ensureGraph, ...(opts.mode ? { propertyMode: opts.mode } : {}) }),
    ...writeTools({ run: fake.run, reader, policy, ensureGraph, graph: 'AI Sandbox', writeGraphs: ['AI Sandbox'], runDir }),
  ];
  const tool = (n: string): ToolDef => tools.find((t) => t.name === n) as ToolDef;
  const read = async (n: string, args: Record<string, unknown>, locality: 'cloud' | 'local' = 'cloud'): Promise<string> => (await tool(n).run(args, { locality })).text;
  return { fake, reader, tool, read };
}

function ctx(locality: 'cloud' | 'local' = 'cloud') {
  const cards: ApprovalRequest[] = [];
  const c: ToolContext = {
    locality,
    chatId: 'c',
    turnId: 't',
    approve: async (req) => {
      cards.push(req);
      return { view: { ...req, id: 'a1', chatId: 'c', turnId: 't', createdAt: 0 }, decision: { decision: 'apply', reason: 'user' } };
    },
  };
  return { c, cards };
}

test('properties: every type is read; public built-ins yes, internal ones no', async () => {
  const { reader } = await setup();
  const props = await reader.properties();
  assert.equal(props.get(P.priority)?.title, 'Priority');
  assert.deepEqual(props.get(P.priority)?.choices.map((c) => c.title), ['Low', 'Medium', 'High']);
  assert.equal(props.get(P.deadline)?.type, 'datetime');
  assert.equal(props.get(P.project)?.many, true);
  assert.equal(props.get(P.rating)?.builtIn, false);
  assert.ok(!props.has(P.createdBy), 'non-public built-ins are skipped');
  const page = await reader.pageByTitle('props test');
  const blocks = await reader.pageBlocks(page?.id as number);
  const b = blocks.find((x) => x.id === 238);
  // The privacy rules see raw values by lower-case title, as before.
  assert.deepEqual(b?.props.get('priority'), ['High']);
  assert.deepEqual(b?.props.get('rating'), ['4']);
  assert.deepEqual(b?.props.get('done'), ['true']);
  assert.deepEqual(b?.props.get('project'), ['Alpha', 'Secret Project']);
  assert.deepEqual(b?.props.get('due'), ['Nov 3rd, 2026']);
  assert.equal(b?.createdAt, new Date(2026, 10, 1, 9, 0).getTime());
});

test('reads show property names by default and values when asked; hidden links stay hidden', async () => {
  const { read } = await setup();
  const plain = await read('get_page', { title: 'Props Test' });
  assert.match(plain, /- Ship the release {2}\(props: Priority, Deadline, rating, done, project, due, website, summary\) {2}\[id:/);
  assert.doesNotMatch(plain, /::/, 'no values unless asked');
  assert.doesNotMatch(plain, /Secret/);

  const full = await read('get_page', { title: 'Props Test', properties: true });
  for (const line of [
    '  Priority:: High',
    '  Deadline:: 2026-11-05 14:30',
    '  rating:: 4',
    '  done:: true',
    '  project:: [[Alpha]], [hidden]',
    '  due:: 2026-11-03',
    '  website:: https://example.com',
    '  summary:: see [hidden]',
  ]) {
    assert.ok(full.includes(line), `missing ${line}\n${full}`);
  }
  assert.doesNotMatch(full, /Secret/);
  assert.doesNotMatch(full, /props:/, 'values replace the names note');

  // get_block always shows the block's own properties and its times.
  const block = await read('get_block', { uuid: BLOCK });
  assert.match(block, /Priority:: High/);
  assert.match(block, /\(created 2026-11-01 09:00, updated 2026-11-02 10:15\)/);
  assert.doesNotMatch(block, /Secret/);

  // Search hits carry the same note / values.
  assert.match(await read('search_blocks', { query: 'ship' }), /\(props: Priority/);
  assert.match(await read('search_blocks', { query: 'ship', properties: true }), /\n {2}rating:: 4/);
});

test('readProperties config: values / off', async () => {
  assert.match(await (await setup({ mode: 'values' })).read('get_page', { title: 'Props Test' }), /Priority:: High/);
  const off = await (await setup({ mode: 'off' })).read('get_page', { title: 'Props Test' });
  assert.doesNotMatch(off, /props:|::/);
  assert.equal(mergeConfig(defaultConfig(), { readProperties: 'values' }).readProperties, 'values');
  assert.throws(() => mergeConfig(defaultConfig(), { readProperties: 'all' }), /readProperties/);
});

test('find_by_property: by value and range, and it cannot be used to probe hidden values', async () => {
  const { read } = await setup();
  assert.match(await read('find_by_property', { name: 'priority', value: 'high' }), /Ship the release.*\n[\s\S]*Priority:: High/);
  assert.match(await read('find_by_property', { name: 'priority', value: 'low' }), /^Nothing visible/);
  assert.match(await read('find_by_property', { name: 'project', value: 'alpha' }), /Ship the release/);
  assert.match(await read('find_by_property', { name: 'project', value: 'secret' }), /^Nothing visible/, 'a hidden page name finds nothing');
  assert.match(await read('find_by_property', { name: 'summary', value: 'secret' }), /^Nothing visible/);
  assert.match(await read('find_by_property', { name: 'deadline', from: '2026-11-01', to: '2026-11-05' }), /Ship the release/);
  assert.match(await read('find_by_property', { name: 'deadline', to: '2026-11-04' }), /^Nothing visible/);
  assert.match(await read('find_by_property', { name: 'rating', from: '3', to: '5' }), /Ship the release/);
  assert.match(await read('find_by_property', { name: 'ai-access' }), /No property named/);
  assert.match(await read('find_by_property', { name: 'nope' }), /No property named/);
  // A block with a hidden parent page isn't listed (Secret Project has ai-access:: none).
  assert.doesNotMatch(await read('find_by_property', { name: 'ai-access' }), /Secret/);
});

test('list_properties: types, choices, what the AI may set', async () => {
  const out = await (await setup({ deny: ['property:website'] })).read('list_properties', {});
  assert.match(out, /- Priority — one of: Low, Medium, High\n/);
  assert.match(out, /- Status — one of: Todo, Doing, Done$/m);
  assert.match(out, /- Deadline — date and time/);
  assert.match(out, /- rating — number\n/);
  assert.match(out, /- project — link to a page \(\[\[Title\]\]\) or block \(\(uuid\)\); several values\n/);
  assert.match(out, /- website — web address \(privacy setting: only the user changes it\)/);
  assert.doesNotMatch(out, /ai-access|Created by/);
});

test('update_blocks set_properties: every type converted, set replaces, status via upsert task', async () => {
  const { fake, tool } = await setup();
  const { c, cards } = ctx();
  const out = await tool('update_blocks').run(
    {
      edits: [
        {
          uuid: BLOCK,
          set_properties: {
            priority: 'low',
            rating: '5',
            done: false,
            Deadline: '2026-11-06 09:00',
            project: ['[[Alpha]]'],
            due: '2026-11-03',
            website: 'https://logseq.com',
            status: 'Done',
          },
          remove_properties: ['summary'],
        },
      ],
    },
    c,
  );
  assert.match(out.text, /^Applied/);
  assert.equal(cards[0]?.title, 'Change properties on a block');
  assert.ok(cards[0]?.warnings.some((w) => w.includes('Replaces 1 value(s) of "project"')), 'the hidden project link is called out');
  assert.ok(cards[0]?.warnings.some((w) => w.includes('Replaces 1 value(s) of "summary"')));
  const body = cards[0]?.body as { kind: 'diffs'; items: { before: string; after: string }[] };
  assert.match(body.items[0]?.before ?? '', /Priority:: High\n.*Deadline:: 2026-11-05 14:30/s);
  assert.match(body.items[0]?.after ?? '', /^Ship the release\nstatus:: Done\nPriority:: Low\n/);

  const call = fake.calls.find((x) => x.command.join(' ') === 'upsert block' && x.options?.uuid === BLOCK);
  const sets = new Map(parseEdn(String(call?.options?.['update-properties'])) as [string, unknown][]);
  assert.equal(sets.get(`:${P.priority}`), 221, 'a fixed choice goes in as its id');
  assert.equal(sets.get(`:${P.rating}`), 5);
  assert.equal(sets.get(`:${P.done}`), false);
  assert.equal(sets.get(`:${P.deadline}`), new Date(2026, 10, 6, 9, 0).getTime());
  assert.deepEqual(sets.get(`:${P.project}`), [235]);
  assert.equal(sets.get(`:${P.due}`), 210, 'a date is the journal page id');
  assert.equal(sets.get(`:${P.website}`), 'https://logseq.com');
  const removed = parseEdn(String(call?.options?.['remove-properties'])) as string[];
  for (const ident of [P.priority, P.rating, P.done, P.deadline, P.project, P.due, P.website, P.summary]) assert.ok(removed.includes(`:${ident}`), `${ident} cleared first`);
  assert.ok(fake.calls.some((x) => x.command.join(' ') === 'upsert task' && x.options?.uuid === BLOCK && x.options.status === 'done'));
  assert.equal(call?.options?.['update-tags'], undefined, 'property-only edits are not tagged #ai');

  const after = (fake.byId.get(238) ?? { props: {} }).props ?? {};
  assert.equal(after[P.summary], undefined);
  assert.equal(fake.byId.get(238)?.status, 'Done');
  assert.equal(after[P.deadline], new Date(2026, 10, 6, 9, 0).getTime());
});

test('update_blocks refuses privacy settings, unknown properties and bad values', async () => {
  const s = await setup({ deny: ['property:rating=99'] });
  const run = (edit: Record<string, unknown>, locality: 'cloud' | 'local' = 'cloud') => s.tool('update_blocks').run({ edits: [{ uuid: BLOCK, ...edit }] }, ctx(locality).c);
  await assert.rejects(run({ set_properties: { 'ai-access': 'cloud-ok' } }), /privacy settings/);
  await assert.rejects(run({ remove_properties: ['ai-access'] }), /privacy settings/);
  await assert.rejects(run({ set_properties: { rating: 3 } }), /privacy settings/, 'properties named in rules are the user\'s');
  await assert.rejects(run({ add_tags: ['private'] }), /privacy tags/);
  await assert.rejects(run({ set_properties: { nope: 'x' } }), /no property "nope"/);
  await assert.rejects(run({ set_properties: { priority: 'urgent' } }), /one of: Low, Medium, High/);
  await assert.rejects(run({ set_properties: { done: 'maybe' } }), /true or false/);
  await assert.rejects(run({ set_properties: { website: 'not a url' } }), /web address/);
  await assert.rejects(run({ set_properties: { due: '2026-12-25' } }), /no journal page for 2026-12-25/);
  await assert.rejects(run({ set_properties: { project: '[[Secret Project]]' } }), /No page named "Secret Project"/, 'a hidden page looks missing');
  await assert.rejects(run({ set_properties: { project: '[[Nowhere]]' } }), /No page named "Nowhere"/);
  await assert.rejects(run({ set_properties: { Deadline: 'tomorrow' } }), /2026-11-05/);
  await assert.rejects(run({ set_properties: { summary: 'see [hidden]' } }), /\[hidden\]/);
  await assert.rejects(run({ remove_properties: ['status'] }), /keeps a status/);
  await assert.rejects(run({ set_properties: { rating: [1, 2] } }), /privacy settings/);
  await assert.rejects(run({ remove_properties: ['nope'] }), /no property "nope"/);
  assert.equal(s.fake.writes.length, 0);
  // A local model sees #private blocks, but may not drop the tag from their text.
  const priv = '00000000-0000-4000-8000-000000000213';
  await assert.rejects(s.tool('update_blocks').run({ edits: [{ uuid: priv, content: 'Private child' }] }, ctx('local').c), /drops #private/);
  await assert.rejects(s.tool('update_blocks').run({ edits: [{ uuid: priv, remove_tags: ['private'] }] }, ctx('local').c), /privacy tags/);
  assert.match((await s.tool('update_blocks').run({ edits: [{ uuid: priv, content: 'Private child, edited #private' }] }, ctx('local').c)).text, /^Applied/);
});

test('date parsing helpers', () => {
  assert.equal(parseDay('2026-11-05'), 20261105);
  assert.equal(parseDay('2026-02-30'), null);
  assert.equal(parseDateTime('2026-11-05 14:30'), DEADLINE_MS);
  assert.equal(parseDateTime('2026-11-05T14:30'), DEADLINE_MS);
  assert.equal(parseDateTime('2026-11-05 25:00'), null);
});

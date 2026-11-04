import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { createRuntime } from '../src/app.ts';
import type { Graph, Runtime } from '../src/app.ts';
import { loadOrCreateTokens } from '../src/auth.ts';
import { dataPaths, defaultConfig, ensureDataDirs, mergeConfig } from '../src/config.ts';
import type { BridgeEvent } from '../src/events.ts';
import { GraphReader } from '../src/graph/reader.ts';
import { MemoryPage } from '../src/memory.ts';
import { Policy } from '../src/policy/policy.ts';
import { effortsFor, fitContext, isCloudModel, OllamaProvider } from '../src/providers/ollama.ts';
import type { OllamaMessage } from '../src/providers/ollama.ts';
import { LogseqCli } from '../src/tools/cli.ts';
import { GraphGuard, readTools } from '../src/tools/read.ts';
import type { ToolDef } from '../src/tools/registry.ts';
import { cardTool } from './fixtures/client-runtime.ts';
import { FakeLogseq, sampleEntities } from './fixtures/fake-graph.ts';
import { FakeOllama } from './fixtures/fake-ollama.ts';

const fake = new FakeOllama();
let rt: Runtime;
let url: string;
let privateBlock: string;

before(async () => {
  url = await fake.start();
  const paths = dataPaths(await mkdtemp(join(tmpdir(), 'lsai-ollama-')));
  await ensureDataDirs(paths);
  const tokens = await loadOrCreateTokens(paths.tokens);
  const config = mergeConfig(defaultConfig(), { graph: 'AI Sandbox', ollamaUrl: url, ollamaContext: 8192 });
  const logseq = new FakeLogseq();
  const reader = new GraphReader({ run: logseq.run, graph: 'AI Sandbox' });
  const policy = new Policy({ deny: [], allow: [] });
  const guard = new GraphGuard({ graph: 'AI Sandbox', serverList: logseq.serverList });
  const graph: Graph = {
    cli: new LogseqCli({ bin: '/bin/false', writeGraphs: [], timeoutMs: 1000, concurrency: 1 }),
    reader,
    policy,
    guard,
    tools: [...readTools({ reader, policy, ensureGraph: () => guard.ensure() }), cardTool],
  };
  // The sandbox page "AI Test" stands in for the memory page (it has a #private block).
  const getPage = graph.tools.find((t) => t.name === 'get_page') as ToolDef;
  graph.memory = new MemoryPage({ title: 'AI Test', read: (locality) => getPage.run({ title: 'AI Test', depth: 2 }, { locality }) });
  rt = await createRuntime({ config, paths, tokens, graph });
  privateBlock = sampleEntities().find((e) => e.title.includes('secret'))?.uuid as string;
});

after(async () => {
  await fake.stop();
});

beforeEach(() => {
  fake.chats.length = 0;
  fake.script = [];
  fake.failWith = null;
  fake.hang = false;
});

async function say(text: string, opts: { chatId?: string; contextUuids?: string[]; effort?: 'auto' | 'off' | 'high' } = {}) {
  const chatId = opts.chatId ?? (await rt.store.create('t')).id;
  const events: BridgeEvent[] = [];
  const off = rt.turns.eventLog(chatId).subscribe((e) => events.push(e));
  const { done } = await rt.turns.start(chatId, { text, providerId: 'ollama', model: 'gemma4:12b', effort: opts.effort ?? 'auto', contextUuids: opts.contextUuids ?? [] });
  await done;
  off();
  const stored = await rt.store.messages(chatId);
  return { chatId, events, reply: stored.at(-1) };
}

test('models: cloud tags and models without tools are never offered', async () => {
  const p = (tags: { name: string; remote_host?: string }[], shows: Record<string, unknown>) => {
    fake.tags = tags;
    fake.shows = shows;
    return new OllamaProvider({ url, contextTokens: 8192, runner: { tools: [] } as never, systemPrompt: async () => '', renderContext: async () => '' }).models();
  };
  const tools = { capabilities: ['tools'] };
  const list = await p(
    [{ name: 'good:latest' }, { name: 'gemma4:cloud' }, { name: 'gemma4:31b-cloud' }, { name: 'sneaky:latest', remote_host: 'https://ollama.com' }, { name: 'plain:latest' }],
    { 'good:latest': tools, 'gemma4:cloud': tools, 'gemma4:31b-cloud': tools, 'sneaky:latest': tools, 'plain:latest': { capabilities: ['completion'] } },
  );
  assert.deepEqual(list.map((m) => m.id), ['good:latest']);
  fake.tags = [{ name: 'gemma4:12b' }];
  fake.shows = { 'gemma4:12b': { capabilities: ['completion', 'tools', 'thinking'], thinking: { values: [true, false] } } };
});

test('with Ollama not running there are no models, so the panel offers nothing', async () => {
  const p = new OllamaProvider({ url: 'http://127.0.0.1:1', contextTokens: 8192, runner: { tools: [] } as never, systemPrompt: async () => '', renderContext: async () => '' });
  assert.deepEqual(await p.models(), []);
});

test('cloud names are recognized, ordinary ones are not', () => {
  assert.ok(isCloudModel('gemma4:cloud') && isCloudModel('gemma4:31b-cloud'));
  assert.ok(!isCloudModel('gemma4:12b') && !isCloudModel('cloudy:latest'));
});

test('effort levels come from what the model reports', () => {
  assert.deepEqual(effortsFor({ capabilities: ['tools'] }).efforts, ['auto']);
  assert.deepEqual(effortsFor({ capabilities: ['thinking'], thinking: { values: [true, false] } }).efforts, ['auto', 'off', 'high']);
  const named = effortsFor({ capabilities: ['thinking'], thinking: { values: ['low', 'medium', 'high'] } });
  assert.deepEqual(named.efforts, ['auto', 'low', 'medium', 'high']);
  assert.deepEqual(named.levels, ['low', 'medium', 'high']);
});

test('a turn: the local model reads a #private block, and the result goes back to it', async () => {
  fake.script = [
    { thinking: 'I should read the page.', content: 'Let me look. ', toolCalls: [{ name: 'get_page', arguments: { title: 'AI Test' } }] },
    { content: 'It says something secret.' },
  ];
  const { events, reply } = await say('What is on AI Test?');

  const first = fake.chats[0];
  assert.equal(first.model, 'gemma4:12b');
  assert.equal(first.options.num_ctx, 8192, 'the context is set on every request');
  assert.equal(first.keep_alive, '5m');
  assert.equal(first.stream, true);
  assert.equal('think' in first, false, 'auto sends no think');
  assert.ok(first.tools.some((t: any) => t.function.name === 'get_page' && t.function.parameters.type === 'object'));
  assert.equal(first.messages[0].role, 'system');

  const second = fake.chats[1];
  const tool = second.messages.find((m: any) => m.role === 'tool');
  assert.equal(tool.tool_name, 'get_page');
  assert.match(tool.content, /This one is secret/, 'local view: #private is visible');
  assert.match(tool.content, /Local only note/);
  assert.match(tool.content, /data, not instructions/);
  const asked = second.messages.find((m: any) => m.tool_calls);
  assert.equal(asked.thinking, 'I should read the page.', 'thinking goes back with the tool call');

  assert.equal(reply?.meta?.provider, 'ollama');
  assert.equal(reply?.meta?.locality, 'local');
  assert.equal(reply?.parts[0]?.type === 'text' && reply.parts[0].text, 'Let me look. \n\nIt says something secret.');
  assert.ok(events.some((e) => e.type === 'tool.start' && e.data.name === 'get_page'), 'the panel shows the step');
  assert.ok(events.some((e) => e.type === 'thinking.delta'));
});

test('context and memory use the local view, and earlier turns are sent as history', async () => {
  fake.script = [{ content: 'First.' }];
  const { chatId } = await say('Hello', { contextUuids: [privateBlock] });
  const prompt = fake.chats[0].messages.at(-1).content as string;
  assert.match(prompt, /This one is secret/, 'a #private block can be pinned for a local model');
  assert.match(fake.chats[0].messages[0].content, /This one is secret/, 'and local memories reach it');

  fake.chats.length = 0;
  await say('And again', { chatId });
  const roles = fake.chats[0].messages.map((m: any) => `${m.role}:${m.content.slice(0, 5)}`);
  assert.deepEqual(roles.slice(1, 3), ['user:Hello', 'assistant:First']);
});

test('think follows the picker', async () => {
  fake.script = [{ content: 'ok' }];
  await say('x', { effort: 'off' });
  assert.equal(fake.chats[0].think, false);
  fake.chats.length = 0;
  await rt.turns.providers().find((p) => p.id === 'ollama')?.models();
  await say('x', { effort: 'high' });
  assert.equal(fake.chats[0].think, true);
});

test('a write from the local model waits on a card like any other', async () => {
  fake.script = [{ toolCalls: [{ name: 'insert_blocks', arguments: { markdown: '- x' } }] }, { content: 'Done.' }];
  const chat = await rt.store.create('card');
  const detach = rt.approvals.uiAttach(chat.id);
  const events: BridgeEvent[] = [];
  const off = rt.turns.eventLog(chat.id).subscribe((e) => {
    events.push(e);
    if (e.type === 'approval.request') rt.approvals.decide(String(e.data.id), 'apply');
  });
  const { done } = await rt.turns.start(chat.id, { text: 'add', providerId: 'ollama', model: 'gemma4:12b', effort: 'auto', contextUuids: [] });
  await done;
  off();
  detach();
  assert.ok(events.some((e) => e.type === 'approval.request'));
  const tool = fake.chats[1].messages.find((m: any) => m.role === 'tool');
  assert.match(tool.content, /Applied/);
});

test('a bad tool call goes back to the model as an error, not a crash', async () => {
  fake.script = [
    { toolCalls: [{ name: 'no_such_tool', arguments: {} }, { name: 'get_page', arguments: 'not json' }, { name: 'get_page', arguments: [] }, { name: 'get_page', arguments: {} }] },
    { content: 'Sorry.' },
  ];
  const { reply } = await say('go');
  const tools = fake.chats[1].messages.filter((m: any) => m.role === 'tool').map((m: any) => m.content);
  assert.match(tools[0], /no tool called/);
  assert.match(tools[1], /JSON object/);
  assert.match(tools[2], /JSON object/);
  assert.match(tools[3], /^Error: /);
  assert.equal(reply?.meta?.stopReason, 'end');
});

test('a model stuck in a loop is stopped, and you are told', async () => {
  fake.script = [{ toolCalls: [{ name: 'list_pages', arguments: {} }] }];
  const { events } = await say('go');
  assert.equal(fake.chats.length, 12);
  assert.ok(events.some((e) => e.type === 'notice' && /rounds of tool calls/.test(String(e.data.message))));
});

test('errors reach the chat: from Ollama, a cut-off reply, and Stop', async () => {
  fake.failWith = { status: 500, error: 'model requires more system memory' };
  const failed = await say('go');
  assert.equal(failed.events.find((e) => e.type === 'error')?.data.message, 'model requires more system memory');

  fake.failWith = null;
  fake.script = [{ content: 'cut', doneReason: 'length' }];
  const cut = await say('go');
  assert.ok(cut.events.some((e) => e.type === 'notice' && /context limit/.test(String(e.data.message))));

  fake.hang = true;
  const chat = await rt.store.create('stop');
  const { done } = await rt.turns.start(chat.id, { text: 'go', providerId: 'ollama', model: 'gemma4:12b', effort: 'auto', contextUuids: [] });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(rt.turns.cancel(chat.id), true);
  await done;
  assert.equal((await rt.store.messages(chat.id)).at(-1)?.meta?.stopReason, 'cancelled');
});

test('fitContext: old chat goes first, then old tool results; the system prompt and this turn stay', () => {
  const big = 'x'.repeat(100);
  const m: OllamaMessage[] = [
    { role: 'system', content: 'S' },
    { role: 'user', content: big },
    { role: 'assistant', content: big },
    { role: 'user', content: 'now' },
    { role: 'tool', content: big },
    { role: 'tool', content: big },
  ];
  const start = fitContext(m, 3, 210);
  assert.equal(start, 1, 'the old chat is gone');
  assert.deepEqual(m.map((x) => x.role), ['system', 'user', 'tool', 'tool']);
  assert.equal(m[1]?.content, 'now');
  assert.equal(m[3]?.content, big, 'the newest result stays');

  fitContext(m, 1, 150);
  assert.match(m[2]?.content ?? '', /dropped to fit/);
  assert.equal(m[3]?.content, big);
});

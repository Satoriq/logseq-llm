import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, test } from 'node:test';
import { AuditLog } from '../src/audit.ts';
import type { StoredMessage } from '../src/chats/store.ts';
import { API_PROVIDER_IDS, defaultConfig, mergeConfig } from '../src/config.ts';
import { EventLog } from '../src/events.ts';
import { GraphReader } from '../src/graph/reader.ts';
import { Policy } from '../src/policy/policy.ts';
import { API_PRESETS, ApiProvider } from '../src/providers/api.ts';
import type { ApiPreset } from '../src/providers/api.ts';
import type { Effort, ProviderEvent } from '../src/providers/types.ts';
import { GraphGuard, readTools } from '../src/tools/read.ts';
import { ToolRunner } from '../src/tools/runner.ts';
import { FakeApi } from './fixtures/fake-api.ts';
import { FakeLogseq, sampleEntities } from './fixtures/fake-graph.ts';

const KEY = 'sk-test-secret-key-1234567890';
const api = new FakeApi();
let url: string;
let runner: ToolRunner;
let auditFile: string;

before(async () => {
  url = await api.start();
  auditFile = join(await mkdtemp(join(tmpdir(), 'lsai-api-')), 'audit.jsonl');
  const logseq = new FakeLogseq();
  const reader = new GraphReader({ run: logseq.run, graph: 'AI Sandbox' });
  const policy = new Policy({ deny: [], allow: [] });
  const guard = new GraphGuard({ graph: 'AI Sandbox', serverList: logseq.serverList });
  const log = new EventLog('e');
  runner = new ToolRunner({ tools: readTools({ reader, policy, ensureGraph: () => guard.ensure() }), audit: new AuditLog(auditFile), events: () => log });
});

after(() => api.stop());
beforeEach(() => api.reset());

const preset = (id: string): ApiPreset => ({ ...(API_PRESETS.find((p) => p.id === id) as ApiPreset), url });

function provider(id: string, over: { key?: string | null; extraModels?: string[]; context?: string } = {}) {
  const key = over.key === undefined ? KEY : over.key;
  return new ApiProvider({
    preset: preset(id),
    secrets: { has: async () => key !== null, get: async () => key },
    runner,
    systemPrompt: async () => 'SYSTEM PROMPT',
    renderContext: async () => over.context ?? '',
    ...(over.extraModels ? { extraModels: over.extraModels } : {}),
  });
}

const user = (text: string, extra = {}): StoredMessage => ({ id: text, role: 'user', ts: 0, parts: [{ type: 'text', text }], meta: { locality: 'cloud', ...extra } });

async function run(id: string, model: string, effort: Effort = 'auto', opts: { messages?: StoredMessage[]; signal?: AbortSignal; context?: string } = {}) {
  const events: ProviderEvent[] = [];
  const result = await provider(id, opts.context === undefined ? {} : { context: opts.context }).runTurn({
    chatId: 'c',
    turnId: 't',
    messages: opts.messages ?? [user('hello')],
    model,
    effort,
    web: false,
    signal: opts.signal ?? new AbortController().signal,
    emit: (e) => events.push(e),
  });
  const text = events.flatMap((e) => (e.type === 'text.delta' ? [e.text] : [])).join('');
  return { result, events, text, notices: events.flatMap((e) => (e.type === 'notice' ? [e.message] : [])) };
}

// ---------- Claude ----------

const claudeText = (t: string, stop = 'end_turn') => [
  { type: 'message_start', message: { usage: { input_tokens: 10, cache_read_input_tokens: 5 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 3 } },
  { type: 'message_stop' },
];

const claudeTool = (name: string, json: string[]) => [
  { type: 'message_start', message: { usage: { input_tokens: 10 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'I should look.' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG123' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name, input: {} } },
  ...json.map((partial_json) => ({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json } })),
  { type: 'content_block_stop', index: 1 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
];

test('Claude: the request has the key, version, prompt, tools, caching and effort', async () => {
  api.script = [claudeText('Hi there')];
  const { text, result } = await run('anthropic', 'claude-opus-5-5', 'high');
  assert.equal(text, 'Hi there');
  assert.deepEqual(result.usage, { inputTokens: 15, outputTokens: 3 });
  const { headers, body } = api.requests[0] as { headers: any; body: any };
  assert.equal(headers['x-api-key'], KEY);
  assert.equal(headers['anthropic-version'], '2026-10-21');
  assert.equal(headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(body.system, 'SYSTEM PROMPT');
  assert.equal(body.stream, true);
  assert.deepEqual(body.output_config, { effort: 'high' });
  assert.deepEqual(body.cache_control, { type: 'ephemeral' });
  assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' });
  assert.equal(body.fallbacks, 'default');
  assert.ok(body.max_tokens > 0);
  assert.ok(body.tools.some((t: any) => t.name === 'get_page' && t.input_schema.type === 'object'));
  assert.ok(!('temperature' in body), 'sampling settings are rejected by this API version');
});

test('Claude: "off" uses what each model accepts, and Auto sends no effort', async () => {
  api.script = [claudeText('ok')];
  await run('anthropic', 'claude-sonnet-5-5', 'off');
  await run('anthropic', 'claude-haiku-5-5', 'off');
  await run('anthropic', 'claude-haiku-5-5', 'auto');
  const [sonnet, haiku, auto] = api.requests.map((r) => r.body);
  assert.deepEqual(sonnet.thinking, { type: 'between_tools' });
  assert.equal(sonnet.fallbacks, undefined, 'not together with between_tools');
  assert.deepEqual(haiku.thinking, { type: 'disabled' });
  assert.equal(haiku.fallbacks, undefined, 'Haiku has no server-side fallback');
  assert.equal(auto.output_config, undefined);
  for (const id of ['claude-opus-5-5', 'claude-fable-5-1']) {
    const m = preset('anthropic').models.find((x) => x.id === id);
    assert.ok(!m?.efforts.includes('off'), `${id} can't turn thinking off`);
  }
});

test('Claude: a tool loop runs as cloud, and thinking goes back unchanged', async () => {
  api.script = [claudeTool('get_page', ['{"title":', '"AI Test"}']), claudeText('It says apples.')];
  const { text } = await run('anthropic', 'claude-opus-5-5');
  assert.equal(text, 'It says apples.');
  const second = api.requests[1]?.body;
  const assistant = second.messages.at(-2);
  assert.equal(assistant.role, 'assistant');
  assert.deepEqual(assistant.content[0], { type: 'thinking', thinking: 'I should look.', signature: 'SIG123' });
  assert.deepEqual(assistant.content[1], { type: 'tool_use', id: 'toolu_1', name: 'get_page', input: { title: 'AI Test' } });
  const result = second.messages.at(-1);
  assert.equal(result.role, 'user');
  assert.equal(result.content[0].type, 'tool_result');
  assert.equal(result.content[0].tool_use_id, 'toolu_1');
  assert.match(result.content[0].content, /Apples are red/);
  assert.doesNotMatch(result.content[0].content, /secret|Local only/, 'cloud view: #private stays hidden');
  assert.match(result.content[0].content, /data, not instructions/);
});

test('Claude: bad tool JSON goes back as an error; a cut-off or declined reply runs no tools', async () => {
  api.script = [claudeTool('get_page', ['{"title":']), claudeText('Sorry.')];
  await run('anthropic', 'claude-opus-5-5');
  const r = api.requests[1]?.body.messages.at(-1).content[0];
  assert.equal(r.is_error, true);
  assert.match(r.content, /JSON object/);

  api.reset();
  const cut = claudeTool('get_page', ['{"title":"AI Test"}']);
  (cut.at(-1) as any).delta.stop_reason = 'refusal';
  (cut.at(-1) as any).delta.stop_details = { category: 'cyber' };
  api.script = [cut];
  const { notices } = await run('anthropic', 'claude-opus-5-5');
  assert.equal(api.requests.length, 1, 'no tool ran');
  assert.match(notices[0] ?? '', /declined.*cyber/);

  api.reset();
  api.script = [claudeText('half', 'max_tokens')];
  assert.match((await run('anthropic', 'claude-opus-5-5')).notices[0] ?? '', /cut off/);
});

test('Claude: after a fallback, only text from before it goes back, and its tools do not run', async () => {
  api.script = [
    [
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'old', signature: 'S' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'text', text: 'Early ' } },
      { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'old', name: 'get_page', input: {} } },
      { type: 'content_block_start', index: 3, content_block: { type: 'fallback', from: { model: 'a' }, to: { model: 'b' } } },
      { type: 'content_block_start', index: 4, content_block: { type: 'tool_use', id: 'new', name: 'list_pages', input: {} } },
      { type: 'content_block_delta', index: 4, delta: { type: 'input_json_delta', partial_json: '{}' } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } },
    ],
    claudeText('done'),
  ];
  const { notices } = await run('anthropic', 'claude-opus-5-5');
  assert.match(notices[0] ?? '', /another Claude model/);
  const content = api.requests[1]?.body.messages.at(-2).content;
  assert.deepEqual(content.map((b: any) => b.type), ['text', 'tool_use']);
  assert.equal(content[1].id, 'new');
  assert.equal(api.requests[1]?.body.messages.at(-1).content[0].tool_use_id, 'new');
});

// ---------- Responses (OpenAI, xAI) ----------

const reasoning = { type: 'reasoning', id: 'rs_1', encrypted_content: 'ENC', summary: [] };

test('OpenAI: notes are not stored, and output items go back unchanged with the result', async () => {
  api.script = [
    [
      { type: 'response.created' },
      { type: 'response.completed', response: { output: [reasoning, { type: 'function_call', call_id: 'call_1', name: 'get_page', arguments: '{"title":"AI Test"}' }], usage: { input_tokens: 7, output_tokens: 2 } } },
    ],
    [
      { type: 'response.output_text.delta', delta: 'Apples' },
      { type: 'response.output_text.delta', delta: ' here' },
      { type: 'response.completed', response: { output: [{ type: 'message', content: [] }], usage: { input_tokens: 9, output_tokens: 4 } } },
    ],
  ];
  const { text, result } = await run('openai', 'gpt-6.1-sol', 'high');
  assert.equal(text, 'Apples here');
  assert.deepEqual(result.usage, { inputTokens: 16, outputTokens: 6 });
  const first = api.requests[0];
  assert.equal(first?.headers.authorization, `Bearer ${KEY}`);
  assert.equal(first?.body.store, false, 'nothing is kept on the provider');
  assert.equal(first?.body.instructions, 'SYSTEM PROMPT');
  assert.deepEqual(first?.body.reasoning, { effort: 'high' });
  assert.ok(first?.body.tools.some((t: any) => t.type === 'function' && t.name === 'get_page' && t.parameters.type === 'object'), 'tools are flat in this format');

  const input = api.requests[1]?.body.input;
  assert.deepEqual(input.at(-3), reasoning, 'reasoning goes back unchanged');
  assert.equal(input.at(-2).type, 'function_call');
  assert.equal(input.at(-1).type, 'function_call_output');
  assert.equal(input.at(-1).call_id, 'call_1');
  assert.match(input.at(-1).output, /Apples are red/);
  assert.doesNotMatch(input.at(-1).output, /secret/);
});

test('OpenAI: Off means none where a model has it; failed and cut-off replies are reported', async () => {
  api.script = [[{ type: 'response.completed', response: { output: [], usage: {} } }]];
  await run('openai', 'gpt-6-luna', 'off');
  assert.deepEqual(api.requests[0]?.body.reasoning, { effort: 'none' });
  assert.ok(!preset('openai').models.find((m) => m.id === 'gpt-6.1-sol')?.efforts.includes('off'));

  api.reset();
  api.script = [[{ type: 'response.failed', response: { error: { message: 'server broke' } } }]];
  const failed = await run('openai', 'gpt-6.1-sol');
  assert.equal(failed.result.stopReason, 'error');
  assert.match(failed.result.error ?? '', /server broke/);

  api.reset();
  api.script = [[{ type: 'response.incomplete', response: { output: [{ type: 'function_call', call_id: 'x', name: 'get_page', arguments: '{' }], usage: {} } }]];
  const cut = await run('openai', 'gpt-6.1-sol');
  assert.match(cut.notices[0] ?? '', /cut off/);
  assert.equal(api.requests.length, 1, 'no tool ran');
});

test('Grok uses the same format, and sends no effort', async () => {
  api.script = [[{ type: 'response.output_text.delta', delta: 'Hi' }, { type: 'response.completed', response: { output: [], usage: {} } }]];
  const { text } = await run('xai', 'grok-4.7');
  assert.equal(text, 'Hi');
  assert.equal(api.requests[0]?.body.reasoning, undefined);
  assert.equal(api.requests[0]?.body.store, false);
});

// ---------- Chat Completions ----------

const chatStream = (calls: any[][]) => [
  ...calls.map((tool_calls) => ({ choices: [{ delta: { tool_calls } }] })),
  { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
  { choices: [], usage: { prompt_tokens: 8, completion_tokens: 2 } },
];
const chatText = (t: string, finish = 'stop') => [{ choices: [{ delta: { content: t } }] }, { choices: [{ delta: {}, finish_reason: finish }] }];

test('Gemini: a tool call in pieces is put together, and its signature goes back', async () => {
  api.script = [
    chatStream([
      [{ index: 0, id: 'c1', type: 'function', function: { name: 'get_page', arguments: '{"title"' }, extra_content: { google: { thought_signature: 'TS' } } }],
      [{ index: 0, function: { arguments: ':"AI Test"}' } }],
    ]),
    chatText('Done.'),
  ];
  const { text, result } = await run('gemini', 'gemini-3.8-flash', 'low');
  assert.equal(text, 'Done.');
  assert.equal(result.usage?.inputTokens, 8);
  const first = api.requests[0]?.body;
  assert.equal(first.messages[0].role, 'system');
  assert.equal(first.reasoning_effort, 'low');
  assert.deepEqual(first.stream_options, { include_usage: true });
  assert.ok(first.tools.some((t: any) => t.function.name === 'get_page'));
  const second = api.requests[1]?.body.messages;
  const call = second.at(-2).tool_calls[0];
  assert.equal(call.function.arguments, '{"title":"AI Test"}');
  assert.deepEqual(call.extra_content, { google: { thought_signature: 'TS' } });
  assert.equal(second.at(-1).role, 'tool');
  assert.equal(second.at(-1).tool_call_id, 'c1');
  assert.equal(second.at(-1).name, undefined);
  assert.match(second.at(-1).content, /Apples are red/);
});

test('DeepSeek: thinking is off, because chats keep only text', async () => {
  api.script = [chatText('Hi')];
  await run('deepseek', 'deepseek-v4-pro');
  assert.deepEqual(api.requests[0]?.body.thinking, { type: 'disabled' });
  assert.equal(api.requests[0]?.body.reasoning_effort, undefined);
});

test('reasoning_content goes back within a turn, for a provider that sends it', async () => {
  api.script = [
    [{ choices: [{ delta: { reasoning_content: 'hmm' } }] }, ...chatStream([[{ index: 0, id: 'c1', function: { name: 'list_pages', arguments: '{}' } }]])],
    chatText('ok'),
  ];
  await run('openrouter', 'openrouter/auto');
  assert.equal(api.requests[1]?.body.messages.at(-2).reasoning_content, 'hmm');
});

test('Mistral: tool results carry the name; the content filter and a cut-off reply are reported', async () => {
  api.script = [chatStream([[{ index: 0, id: 'c1', function: { name: 'list_pages', arguments: '{}' } }]]), chatText('ok')];
  await run('mistral', 'mistral-large-latest');
  assert.equal(api.requests[1]?.body.messages.at(-1).name, 'list_pages');

  api.reset();
  api.script = [chatText('', 'content_filter')];
  assert.match((await run('mistral', 'mistral-large-latest')).notices[0] ?? '', /content filter/);
  api.reset();
  api.script = [chatText('half', 'length')];
  assert.match((await run('mistral', 'mistral-large-latest')).notices[0] ?? '', /cut off/);
});

test('a stream that stops without finishing is an error, in every format', async () => {
  api.script = [[{ type: 'message_start', message: { usage: {} } }]];
  assert.match((await run('anthropic', 'claude-opus-5-5')).result.error ?? '', /ended early/);
  api.script = [[{ type: 'response.created' }]];
  api.requests.length = 0;
  assert.match((await run('openai', 'gpt-6.1-sol')).result.error ?? '', /ended early/);
  api.script = [[{ choices: [{ delta: { content: 'x' } }] }]];
  api.requests.length = 0;
  assert.match((await run('gemini', 'gemini-3.8-flash')).result.error ?? '', /ended early/);
});

// ---------- shared ----------

test('a provider is only offered once it has a key', async () => {
  assert.deepEqual(await provider('openai', { key: null }).models(), []);
  assert.equal((await provider('openai').models())[0]?.id, 'gpt-6.1-sol');
  const noKey = await provider('openai', { key: null }).runTurn({ chatId: 'c', turnId: 't', messages: [user('x')], model: 'm', effort: 'auto', web: false, signal: new AbortController().signal, emit: () => {} });
  assert.equal(noKey.stopReason, 'error');
  assert.match(noKey.error ?? '', /No API key/);
  assert.equal(api.requests.length, 0);
});

test('config can add models, but not change where a key goes', async () => {
  const ids = (await provider('openai', { extraModels: ['gpt-7', 'gpt-6.1-sol'] }).models()).map((m) => m.id);
  assert.equal(ids.filter((i) => i === 'gpt-6.1-sol').length, 1);
  assert.ok(ids.includes('gpt-7'));
  assert.deepEqual(mergeConfig(defaultConfig(), { apiModels: { openai: ['gpt-7'] } }).apiModels, { openai: ['gpt-7'] });
  assert.throws(() => mergeConfig(defaultConfig(), { apiModels: { opnai: ['x'] } }), /unknown provider/);
  assert.throws(() => mergeConfig(defaultConfig(), { apiModels: { openai: ['a b'] } }), /model ids/);
  assert.throws(() => mergeConfig(defaultConfig(), { apiUrl: 'https://evil.example' }), /unknown key/);
  assert.deepEqual(API_PRESETS.map((p) => p.id), API_PROVIDER_IDS);
  for (const p of API_PRESETS) {
    assert.match(p.url, /^https:\/\//, `${p.id} is https`);
    assert.ok(p.models.length > 0);
  }
});

test('a refused key says so; the key never reaches a message, the audit log or an event', async () => {
  api.failures = [{ status: 401, body: { error: { message: `bad key ${KEY}` } } }];
  const { result, events } = await run('openai', 'gpt-6.1-sol');
  assert.equal(result.stopReason, 'error');
  assert.match(result.error ?? '', /refused the API key/);
  assert.ok(!(result.error ?? '').includes(KEY));
  assert.ok(!JSON.stringify(events).includes(KEY));
  await readFile(auditFile, 'utf8').then((a) => assert.ok(!a.includes(KEY))).catch(() => undefined);
});

test('rate limits and server errors are retried; other errors are not', async () => {
  api.failures = [{ status: 429, headers: { 'retry-after': '0' } }, { status: 500 }];
  api.script = [[], [], chatText('finally')];
  assert.equal((await run('gemini', 'gemini-3.8-flash')).text, 'finally');
  assert.equal(api.requests.length, 3);

  api.reset();
  api.failures = [{ status: 400, body: { error: { message: 'tools are invalid' } } }];
  const bad = await run('gemini', 'gemini-3.8-flash');
  assert.match(bad.result.error ?? '', /Google Gemini: tools are invalid/);
  assert.equal(api.requests.length, 1);

  api.reset();
  api.failures = [{ status: 400, body: [{ error: { code: 400, message: 'model is not specified' } }] }];
  assert.match((await run('gemini', 'gemini-3.8-flash')).result.error ?? '', /model is not specified/);
});

test('Stop ends a reply mid-stream', async () => {
  api.hang = true;
  api.script = [[{ choices: [{ delta: { content: 'Working' } }] }]];
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  assert.equal((await run('mistral', 'mistral-large-latest', 'auto', { signal: ac.signal })).result.stopReason, 'cancelled');
});

test('all earlier turns and the context go along', async () => {
  api.script = [chatText('ok')];
  const many = Array.from({ length: 60 }, (_, i): StoredMessage => ({ id: String(i), role: i % 2 ? 'assistant' : 'user', ts: 0, parts: [{ type: 'text', text: `m${i}` }], meta: { locality: 'cloud' } }));
  const uuid = sampleEntities()[0]?.uuid as string;
  await run('mistral', 'mistral-large-latest', 'auto', { messages: [...many, user('now', { contextUuids: [uuid] })], context: 'THE PAGE' });
  const sent = api.requests[0]?.body.messages;
  assert.equal(sent.length, 1 + 60 + 1, 'system, every earlier message, the new one');
  assert.match(sent.at(-1).content, /<context>\nTHE PAGE\n<\/context>/);
  assert.match(sent.at(-1).content, /now$/);
});

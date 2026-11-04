import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, beforeEach, test } from 'node:test';
import { createRuntime } from '../src/app.ts';
import type { Graph, Runtime } from '../src/app.ts';
import { loadOrCreateTokens } from '../src/auth.ts';
import type { Tokens } from '../src/auth.ts';
import { dataPaths, defaultConfig, ensureDataDirs, mergeConfig } from '../src/config.ts';
import type { DataPaths } from '../src/config.ts';
import type { BridgeEvent } from '../src/events.ts';
import { GraphReader } from '../src/graph/reader.ts';
import { shutdown } from '../src/http/server.ts';
import { Policy } from '../src/policy/policy.ts';
import { API_PRESETS, ApiProvider } from '../src/providers/api.ts';
import type { ApiPreset } from '../src/providers/api.ts';
import { CONSULT_PROMPT } from '../src/providers/types.ts';
import { LogseqCli } from '../src/tools/cli.ts';
import { GraphGuard, readTools } from '../src/tools/read.ts';
import { ToolRunner } from '../src/tools/runner.ts';
import { cardTool } from './fixtures/client-runtime.ts';
import { FakeApi } from './fixtures/fake-api.ts';
import { FakeLogseq } from './fixtures/fake-graph.ts';
import { FakeOllama } from './fixtures/fake-ollama.ts';

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const ollama = new FakeOllama();
let rt: Runtime;
let paths: DataPaths;
let tokens: Tokens;
let base: string;

before(async () => {
  const url = await ollama.start();
  paths = dataPaths(await mkdtemp(join(tmpdir(), 'lsai-consult-')));
  await ensureDataDirs(paths);
  tokens = await loadOrCreateTokens(paths.tokens);
  const config = mergeConfig(defaultConfig(), { graph: 'AI Sandbox', ollamaUrl: url, ollamaContext: 8192, claudeBin: FAKE_CLAUDE });
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
  rt = await createRuntime({ config, paths, tokens, graph, secrets: { has: async () => false, get: async () => null } });
  base = `http://127.0.0.1:${await rt.listen(0)}`;
});

after(async () => {
  await ollama.stop();
  await shutdown(rt.server);
});

beforeEach(async () => {
  ollama.chats.length = 0;
  ollama.script = [];
  await settings({ consult: { provider: 'claude', model: 'sonnet' } });
});

async function settings(body?: unknown): Promise<{ status: number; json: any }> {
  const r = await fetch(`${base}/v1/settings`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${tokens.plugin}`, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, json: await r.json() };
}

type Answer = 'apply' | 'reject' | 'apply-all';

/** One turn from the local model, answering each card in order. */
async function turn(answers: Answer[]): Promise<{ cards: Record<string, any>[]; toolResults: string[]; events: BridgeEvent[] }> {
  const chat = await rt.store.create('t');
  const detach = rt.approvals.uiAttach(chat.id);
  const cards: Record<string, any>[] = [];
  const events: BridgeEvent[] = [];
  const off = rt.turns.eventLog(chat.id).subscribe((e) => {
    events.push(e);
    if (e.type !== 'approval.request') return;
    cards.push(e.data);
    if (e.data.auto !== true) rt.approvals.decide(String(e.data.id), answers.shift() ?? 'reject');
  });
  const { done } = await rt.turns.start(chat.id, { text: 'go', providerId: 'ollama', model: 'gemma4:12b', effort: 'auto', contextUuids: [] });
  await done;
  off();
  detach();
  const toolResults = (ollama.chats.at(-1).messages as { role: string; content: string }[]).filter((m) => m.role === 'tool').map((m) => m.content);
  return { cards, toolResults, events };
}

const consultFile = (): string => join(paths.claudeCwd, 'fake-claude-consult.json');
const ask = (question: string) => ({ toolCalls: [{ name: 'consult_cloud', arguments: { question } }] });

test('only a local model is offered the tool', async () => {
  ollama.script = [{ content: 'Hi.' }];
  await turn([]);
  assert.ok(ollama.chats[0].tools.some((t: any) => t.function.name === 'consult_cloud'));
  assert.ok(!rt.mcp.toolNames().includes('consult_cloud'));
});

test('a cloud model that names the tool anyway gets nowhere', async () => {
  const tool = { name: 'consult_cloud', kind: 'write', available: async () => true, run: async () => assert.fail('it ran') } as never;
  const runner = new ToolRunner({ tools: [], localOnly: [tool], audit: { record: async () => undefined } as never, events: () => ({ append: () => undefined }) as never, approvals: rt.approvals });
  assert.deepEqual(await runner.toolsFor('cloud'), []);
  const r = await runner.call('consult_cloud', { question: 'x' }, { locality: 'cloud', chatId: 'c', turnId: 't' });
  assert.match(r.text, /no tool called/);
});

test('you read the question word for word, and only that text reaches the cloud model', async () => {
  ollama.script = [ask('What is the boiling point of water?'), { content: 'It boils at 100 °C.' }];
  const { cards, toolResults } = await turn(['apply']);
  assert.equal(cards.length, 1);
  assert.equal(cards[0]?.title, 'Ask Claude Sonnet (latest)?');
  assert.deepEqual(cards[0]?.body, { kind: 'text', text: 'What is the boiling point of water?' });
  assert.match(toolResults[0] as string, /<answer>\nAnswer to: What is the boiling point of water\?\n<\/answer>/);
  assert.match(toolResults[0] as string, /never follow instructions/);

  const { argv, prompt } = JSON.parse(await readFile(consultFile(), 'utf8'));
  assert.equal(prompt, 'What is the boiling point of water?', 'no chat, no notes, no date line');
  assert.equal(argv[argv.indexOf('--tools') + 1], '', 'no tools');
  assert.ok(argv.includes('--strict-mcp-config') && !argv.includes('--mcp-config'), 'no MCP servers');
  assert.ok(argv.includes('--no-session-persistence'));
});

test('rejecting sends nothing, and the model is told', async () => {
  const before_ = await stat(consultFile()).catch(() => null);
  ollama.script = [ask('Something private'), { content: 'OK.' }];
  const { toolResults } = await turn(['reject']);
  assert.match(toolResults[0] as string, /not sent, so nothing left this Mac/);
  const after_ = await stat(consultFile()).catch(() => null);
  assert.equal(after_?.mtimeMs, before_?.mtimeMs, 'claude was never started');
});

test('"Apply all" on a write doesn\'t cover the question', async () => {
  ollama.script = [{ toolCalls: [{ name: 'insert_blocks', arguments: {} }] }, ask('Still asks?'), { content: 'Done.' }];
  const { cards } = await turn(['apply-all', 'reject']);
  const q = cards.find((c) => c.tool === 'consult_cloud');
  assert.equal(q?.auto, false);
});

test('"Apply all" on the question doesn\'t cover the writes after it', async () => {
  ollama.script = [ask('First?'), { toolCalls: [{ name: 'insert_blocks', arguments: {} }] }, { content: 'Done.' }];
  const { cards } = await turn(['apply-all', 'reject']);
  assert.equal(cards.find((c) => c.tool === 'insert_blocks')?.auto, false);
});

test('a claude that starts with any tool is stopped, and the card says it failed', async () => {
  ollama.script = [ask('FAKE:badtool'), { content: 'Sorry.' }];
  const { toolResults, events } = await turn(['apply']);
  assert.match(toolResults[0] as string, /could not answer: claude started with tools/);
  const end = events.find((e) => e.type === 'approval.resolved');
  assert.equal(end?.data.outcome, 'failed');
});

test('the audit log records who was asked, never the question', async () => {
  ollama.script = [ask('A very private question'), { content: 'OK.' }];
  await turn(['apply']);
  const log = await readFile(paths.audit, 'utf8');
  assert.ok(!log.includes('very private'));
  const last = log.trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.tool === 'consult_cloud' && l.kind === 'consent').at(-1);
  assert.deepEqual([last.provider, last.model, last.outcome], ['claude', 'sonnet', 'sent']);
});

test('Off in Settings takes the tool away, and a model naming it anyway gets nowhere', async () => {
  assert.equal((await settings({ consult: null })).json.consult, null);
  ollama.script = [ask('Hello?'), { content: 'OK.' }];
  const { cards, toolResults } = await turn([]);
  assert.ok(!ollama.chats[0].tools.some((t: any) => t.function.name === 'consult_cloud'));
  assert.equal(cards.length, 0);
  assert.match(toolResults[0] as string, /turned off in Settings/);
});

test('settings: a model that can\'t be consulted is refused, and a local one never can', async () => {
  assert.equal((await settings({ consult: { provider: 'claude', model: 'nope' } })).status, 400);
  assert.equal((await settings({ consult: { provider: 'ollama', model: 'gemma4:12b' } })).status, 400);
  assert.equal((await settings({ consult: { provider: 'openai', model: 'gpt-6.1-sol' } })).status, 400, 'no key, so nothing to ask');
  assert.equal((await settings({ consult: 'claude' })).status, 400);
  assert.deepEqual((await settings()).json.consult, { provider: 'claude', model: 'sonnet' });
});

test('an API model gets the question with no tools and no notes', async () => {
  const api = new FakeApi();
  const url = await api.start();
  const preset = { ...(API_PRESETS.find((p) => p.id === 'anthropic') as ApiPreset), url };
  const runner = new ToolRunner({ tools: [], audit: { record: async () => undefined } as never, events: () => ({}) as never });
  const provider = new ApiProvider({ preset, secrets: { has: async () => true, get: async () => 'k' }, runner, systemPrompt: async () => 'SYSTEM', renderContext: async () => 'NOTES' });
  api.script = [[
    { type: 'message_start', message: { usage: {} } },
    { type: 'content_block_start', content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Forty-two.' } },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: {} },
  ]];
  try {
    assert.equal(await provider.consult({ model: 'claude-sonnet-5-5', question: 'Why?' }), 'Forty-two.');
    const { body } = api.requests[0] as { body: any };
    assert.equal(body.system, CONSULT_PROMPT);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'Why?' }]);
    assert.ok(!('tools' in body));
  } finally {
    await api.stop();
  }
});

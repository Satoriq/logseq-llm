import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { before, test } from 'node:test';
import type { Runtime } from '../src/app.ts';
import { Approvals } from '../src/approvals.ts';
import { AuditLog } from '../src/audit.ts';
import type { DataPaths } from '../src/config.ts';
import { EventLog } from '../src/events.ts';
import { APPS_CHAT_ID, clientConfigPath, connectClient, disconnectClient, readClientTokens } from '../src/mcp/clients.ts';
import { McpEndpoint } from '../src/mcp/endpoint.ts';
import { ToolRunner } from '../src/tools/runner.ts';
import { NOT_CONNECTED, runStdio } from '../src/mcp/stdio.ts';
import { cardTool, clientRuntime } from './fixtures/client-runtime.ts';

let rt: Runtime;
let paths: DataPaths;
let home: string;
let token: string;

const app = { client: 'claude-desktop', locality: 'cloud' } as const;
const opts = () => ({ tokensFile: paths.mcpClients, home, node: '/opt/node 26/bin/node', script: '/opt/my repo/bin/logseq-ai-bridge.ts' });

before(async () => {
  ({ rt, paths, home, token } = await clientRuntime());
});

const call = (name: string, args: unknown = {}) => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
const result = async (body: unknown): Promise<any> => ((await rt.mcp.handle(body, app)).body as { result: unknown }).result;

test('a connected app reads through the privacy filter, as cloud', async () => {
  const r = await result(call('get_page', { title: 'AI Test' }));
  const text = r.content[0].text as string;
  assert.match(text, /Apples are red/);
  assert.doesNotMatch(text, /secret|Local only/);
  assert.match(text, /data, not instructions/);
});

test('an app is told to quote block text, not ids; the panel keeps its [[uuid]] links', async () => {
  const read = call('get_page', { title: 'AI Test' });
  assert.match((await result(read)).content[0].text, /never show its id/);
  const s = rt.mcp.sessions.create('00000000-0000-4000-8000-000000000001', 'turn', 'cloud');
  try {
    const r = (await rt.mcp.handle(read, s)).body as { result: { content: { text: string }[] } };
    assert.doesNotMatch(r.result.content[0]?.text ?? '', /never show its id/);
  } finally {
    rt.mcp.sessions.revoke(s);
  }
  const tools = (await result({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).tools as { description: string }[];
  assert.ok(!tools.some((t) => /\[\[uuid\]\]/.test(t.description)), 'no tool asks for [[uuid]] citations');
});

test('a connected app gets the write tools and check_change, but not the memory tools', async () => {
  const names = ((await result({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).tools as { name: string }[]).map((t) => t.name);
  assert.ok(names.includes('get_page') && names.includes('insert_blocks') && names.includes('check_change'));
  assert.ok(!names.includes('remember'));
  const r = await result(call('remember', { fact: 'x' }));
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /unknown tool/);
});

test('with no panel watching, an app write is refused at once', async () => {
  const t0 = Date.now();
  const r = await result(call('insert_blocks', { page: 'AI Test', markdown: '- x' }));
  assert.ok(Date.now() - t0 < 1000);
  assert.match(r.content[0].text, /Not applied: no-panel/);
});

function endpoint(opts: { appWaitMs?: number; appTurnIdleMs?: number }) {
  const logs = new Map<string, EventLog>();
  const events = (id: string): EventLog => {
    const log = logs.get(id) ?? new EventLog('e');
    logs.set(id, log);
    return log;
  };
  const approvals = new Approvals({ events });
  approvals.uiAttach(APPS_CHAT_ID);
  const runner = new ToolRunner({ tools: [cardTool], audit: new AuditLog(join(home, 'endpoint-audit.jsonl')), events, approvals });
  const mcp = new McpEndpoint({ runner, ...opts });
  const cards = (): any[] => events(APPS_CHAT_ID).since(0).events.filter((e) => e.type === 'approval.request').map((e) => e.data);
  const waitForCard = async (n: number): Promise<any> => {
    while (cards().length < n) await new Promise((r) => setTimeout(r, 2));
    return cards()[n - 1];
  };
  const tool = async (args: unknown, name = 'insert_blocks', who: { client: string; locality: 'cloud' } = app): Promise<any> =>
    ((await mcp.handle(call(name, args), who)).body as { result: unknown }).result;
  return { approvals, cards, waitForCard, tool };
}

const idIn = (r: any): string => /id "([0-9a-f-]+)"/.exec(r.content[0].text)?.[1] as string;

test('an app write shows a card in the apps chat, named after the app, and waits for it', async () => {
  const e = endpoint({ appWaitMs: 2000 });
  const pending = e.tool({});
  const card = await e.waitForCard(1);
  assert.equal(card.title, 'Claude Desktop: Add a block');
  assert.equal(card.chatId, APPS_CHAT_ID);
  assert.equal(e.approvals.decide(card.id, 'apply'), true);
  assert.match((await pending).content[0].text, /Applied: added a block/);
});

test('a slow approval: the app is told to wait, not to repeat it, and check_change gets the result', async () => {
  const e = endpoint({ appWaitMs: 20 });
  const first = await e.tool({});
  assert.match(first.content[0].text, /waiting for the user's approval/);
  assert.match(first.content[0].text, /Don't make this change again/);
  const id = idIn(first);

  // The card outlives the tool call: nothing is decided or dropped when the wait ends.
  const card = await e.waitForCard(1);
  assert.equal(e.approvals.pending(APPS_CHAT_ID).length, 1);
  assert.match((await e.tool({ id }, 'check_change')).content[0].text, /waiting for the user's approval/);

  // Another app can't read it.
  const other = await e.tool({ id }, 'check_change', { client: 'codex', locality: 'cloud' });
  assert.equal(other.isError, true);

  assert.equal(e.approvals.decide(card.id, 'apply'), true);
  assert.match((await e.tool({ id }, 'check_change')).content[0].text, /Applied: added a block/);
  assert.equal((await e.tool({ id }, 'check_change')).isError, true, 'a result is handed over once');
  assert.equal(e.cards().length, 1, 'one change, one card');
});

test('"Apply all" from an app ends when the app goes quiet', async () => {
  const e = endpoint({ appWaitMs: 2000, appTurnIdleMs: 30 });
  const first = e.tool({});
  const card = await e.waitForCard(1);
  assert.equal(e.approvals.decide(card.id, 'apply-all'), true);
  await first;

  await e.tool({});
  assert.equal(e.cards()[1].auto, true, 'trusted while the app keeps going');

  await new Promise((r) => setTimeout(r, 50));
  const later = e.tool({});
  const third = await e.waitForCard(3);
  assert.notEqual(third.auto, true, 'asks again after a quiet spell');
  assert.equal(e.approvals.decide(third.id, 'reject'), true);
  await later;
});

test('a chat turn on the same bridge keeps its write tools', async () => {
  const s = rt.mcp.sessions.create('00000000-0000-4000-8000-000000000001', 'turn', 'cloud');
  try {
    const list = (await rt.mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, s)).body as { result: { tools: { name: string }[] } };
    assert.ok(list.result.tools.some((t) => t.name === 'insert_blocks'));
  } finally {
    rt.mcp.sessions.revoke(s);
  }
});

test('the app is told that notes are data, and the audit log names it without any note text', async () => {
  const init = await result({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.match(init.instructions, /untrusted data/);
  await result(call('search_blocks', { query: 'apples' }));
  const lines = (await readFile(paths.audit, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  const entry = lines.findLast((l) => l.tool === 'search_blocks');
  assert.equal(entry.chatId, 'client:claude-desktop');
  assert.equal(entry.locality, 'cloud');
  assert.doesNotMatch(JSON.stringify(lines), /Apples are red/);
});

test('tokens: a plugin-sized wrong token is nobody, and a damaged token file means no app', async () => {
  assert.equal(await rt.mcp.client('x'.repeat(43)), null);
  assert.equal(await rt.mcp.client(null), null);
  assert.deepEqual(await rt.mcp.client(token), app);
  const damaged = join(home, 'damaged.json');
  await writeFile(damaged, '{ not json');
  assert.deepEqual(await readClientTokens(damaged), {});
  await writeFile(damaged, JSON.stringify({ 'claude-desktop': 'short', unknown: 'y'.repeat(43) }));
  assert.deepEqual(await readClientTokens(damaged), {});
});

async function stdio(lines: unknown[], t: string | undefined): Promise<any[]> {
  const input = new PassThrough();
  const output = new PassThrough();
  let out = '';
  output.on('data', (c) => (out += c));
  const done = runStdio({ port: 1, token: async () => t, input, output });
  for (const l of lines) input.write(`${typeof l === 'string' ? l : JSON.stringify(l)}\n`);
  input.end();
  await done;
  return out.trim() === '' ? [] : out.trim().split('\n').map((l) => JSON.parse(l));
}

test('stdio without a bridge: no token, bad JSON and notifications', async () => {
  assert.equal((await stdio([{ jsonrpc: '2.0', id: 7, method: 'tools/list' }], undefined))[0].error.message, NOT_CONNECTED);
  assert.equal((await stdio(['{oops'], token))[0].error.code, -32700);
  assert.deepEqual(await stdio([{ jsonrpc: '2.0', method: 'notifications/initialized' }], undefined), []);
});

test('connect for Claude Desktop keeps every other setting, keeps a backup and is safe to repeat', async () => {
  const h = await mkdtemp(join(tmpdir(), 'lsai-home-'));
  const file = clientConfigPath('claude-desktop', h);
  await mkdir(dirname(file), { recursive: true });
  const original = JSON.stringify({ preferences: { a: 1 }, mcpServers: { other: { command: 'x' } } });
  await writeFile(file, original);
  const o = { ...opts(), home: h, tokensFile: join(h, 'tokens.json') };

  await connectClient('claude-desktop', o);
  const first = (await readClientTokens(o.tokensFile))['claude-desktop'];
  await connectClient('claude-desktop', o);
  assert.equal((await readClientTokens(o.tokensFile))['claude-desktop'], first, 'connecting again keeps the token');
  assert.equal((await stat(o.tokensFile)).mode & 0o777, 0o600);
  assert.equal((await stat(file)).mode & 0o777, 0o600);

  const c = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(c.preferences, { a: 1 });
  assert.deepEqual(c.mcpServers.other, { command: 'x' });
  assert.deepEqual(c.mcpServers['logseq-ai'], { command: o.node, args: [o.script, 'mcp', 'claude-desktop'] });
  assert.ok(!(await readFile(file, 'utf8')).includes(first as string), 'the token stays out of the app config');

  await disconnectClient('claude-desktop', o);
  const gone = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(Object.keys(gone.mcpServers), ['other']);
  assert.deepEqual(await readClientTokens(o.tokensFile), {});
});

test('connect leaves a damaged Claude Desktop config alone', async () => {
  const h = await mkdtemp(join(tmpdir(), 'lsai-home-'));
  const file = clientConfigPath('claude-desktop', h);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, '{ not json');
  const o = { ...opts(), home: h, tokensFile: join(h, 'tokens.json') };
  await assert.rejects(connectClient('claude-desktop', o), /isn't valid JSON/);
  assert.equal(await readFile(file, 'utf8'), '{ not json');
  assert.deepEqual(await readClientTokens(o.tokensFile), {});
});

test('connect for Codex adds one table and disconnect removes only that table', async () => {
  const h = await mkdtemp(join(tmpdir(), 'lsai-home-'));
  const file = clientConfigPath('codex', h);
  await mkdir(dirname(file), { recursive: true });
  const original = 'model = "x"\n\n[projects."/a"]\ntrust_level = "trusted"\n';
  await writeFile(file, original);
  const o = { ...opts(), home: h, tokensFile: join(h, 'tokens.json') };

  await connectClient('codex', o);
  await connectClient('codex', o);
  const text = await readFile(file, 'utf8');
  assert.equal(text.match(/\[mcp_servers\.logseq-ai\]/g)?.length, 1);
  assert.ok(text.startsWith(original.trimEnd()));
  assert.ok(text.includes('command = "/opt/node 26/bin/node"\nargs = ["/opt/my repo/bin/logseq-ai-bridge.ts", "mcp", "codex"]\n'));

  await writeFile(file, `${text}\n[after]\nkeep = true\n`);
  await disconnectClient('codex', o);
  const left = await readFile(file, 'utf8');
  assert.ok(!left.includes('logseq-ai'));
  assert.ok(left.includes('trust_level = "trusted"') && left.includes('[after]\nkeep = true'));
});

test('disconnect cuts an app off at once, without a bridge restart', async () => {
  assert.deepEqual(await rt.mcp.client(token), app);
  await disconnectClient('claude-desktop', opts());
  assert.equal(await rt.mcp.client(token), null);
});

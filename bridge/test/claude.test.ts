import assert from 'node:assert/strict';
import { request } from 'node:http';
import { access, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
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
import { LogseqCli } from '../src/tools/cli.ts';
import { GraphGuard, readTools } from '../src/tools/read.ts';
import { FakeLogseq } from './fixtures/fake-graph.ts';

const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
let rt: Runtime;
let paths: DataPaths;
let tokens: Tokens;
let port: number;

before(async () => {
  paths = dataPaths(await mkdtemp(join(tmpdir(), 'lsai-claude-')));
  await ensureDataDirs(paths);
  tokens = await loadOrCreateTokens(paths.tokens);
  const config = mergeConfig(defaultConfig(), { graph: 'AI Sandbox', claudeBin: FAKE_CLAUDE, logseqBin: FAKE_CLAUDE });
  const fake = new FakeLogseq();
  const reader = new GraphReader({ run: fake.run, graph: 'AI Sandbox' });
  const policy = new Policy({ deny: [], allow: [] });
  const guard = new GraphGuard({ graph: 'AI Sandbox', serverList: fake.serverList });
  const graph: Graph = {
    cli: new LogseqCli({ bin: FAKE_CLAUDE, writeGraphs: [], timeoutMs: 1000, concurrency: 1 }),
    reader,
    policy,
    guard,
    tools: readTools({ reader, policy, ensureGraph: () => guard.ensure() }),
  };
  process.env.ANTHROPIC_API_KEY = 'sk-should-never-reach-claude';
  rt = await createRuntime({ config, paths, tokens, graph });
  port = await rt.listen(0);
});

after(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  await shutdown(rt.server);
});

async function turn(chatId: string, text: string, opts: { provider?: string; context?: string[] } = {}): Promise<BridgeEvent[]> {
  const events: BridgeEvent[] = [];
  const off = rt.turns.eventLog(chatId).subscribe((e) => events.push(e));
  const providerId = opts.provider ?? 'claude';
  const isClaude = providerId === 'claude';
  const { done } = await rt.turns.start(chatId, {
    text,
    providerId,
    model: isClaude ? 'sonnet' : 'echo',
    effort: isClaude ? 'medium' : 'auto',
    contextUuids: opts.context ?? [],
  });
  await done;
  off();
  return events;
}

const textOf = (events: BridgeEvent[]): string => events.filter((e) => e.type === 'text.delta').map((e) => String(e.data.text)).join('');
const fakeFile = async (name: string): Promise<string> => readFile(join(paths.claudeCwd, name), 'utf8');

test('claude turn: exact flags, filtered tools over MCP, session saved, nothing left behind', async () => {
  const chat = await rt.store.create('t1');
  const events = await turn(chat.id, 'hello FAKE:tool');
  const text = textOf(events);
  assert.match(text, /Hello from fake claude \(new\)/);
  assert.match(text, /tools=7/);
  assert.match(text, /Apples are red/);
  assert.ok(!text.includes('secret'), 'claude is cloud: #private content must not come through MCP');
  assert.ok(!text.includes('Local only note'));
  assert.match(text, /data, not instructions/);
  assert.ok(events.some((e) => e.type === 'tool.start' && e.data.name === 'get_page'));
  assert.ok(events.some((e) => e.type === 'tool.end' && e.data.ok === true && Number(e.data.hiddenCount) > 0));
  assert.equal(events.at(-1)?.type, 'turn.end');
  assert.equal(events.at(-1)?.data.stopReason, 'end');

  const argv = JSON.parse(await fakeFile('fake-claude-argv.json')) as string[];
  for (const f of ['-p', '--verbose', '--include-partial-messages', '--restricted', '--strict-mcp-config', '--disable-slash-commands']) {
    assert.ok(argv.includes(f), f);
  }
  const after_ = (f: string): string | undefined => argv[argv.indexOf(f) + 1];
  assert.equal(after_('--tools'), '');
  assert.equal(after_('--output-format'), 'stream-json');
  assert.equal(after_('--permission-mode'), 'dontAsk');
  assert.equal(after_('--permission-prompts'), 'none');
  assert.equal(after_('--model'), 'sonnet');
  assert.equal(after_('--effort'), 'medium');
  assert.ok(after_('--allowedTools')?.split(',').every((t) => t.startsWith('mcp__lsq__')));
  assert.ok(!argv.includes('--bare'), '--bare would break the Pro login');
  assert.ok(!argv.includes('--resume'));
  const sessionId = after_('--session-id');
  assert.match(String(sessionId), /^[0-9a-f-]{36}$/);
  assert.equal((await rt.store.get(chat.id))?.claudeSessionId, sessionId);

  const env = JSON.parse(await fakeFile('fake-claude-env.json')) as string[];
  assert.ok(!env.includes('ANTHROPIC_API_KEY'), 'an API key in the bridge env must not reach claude');
  assert.equal(rt.mcp.sessions.size, 0, 'MCP token revoked after the turn');
  assert.deepEqual((await readdir(paths.run)).filter((f) => f.startsWith('mcp-')), [], 'MCP config file deleted');

  // The old MCP token no longer works.
  const mcp = JSON.parse(await fakeFile('fake-claude-mcp.json')) as { headers: Record<string, string> };
  assert.equal(await mcpStatus(mcp.headers.Authorization), 401);

  // Second turn resumes the same session, without a handoff.
  const second = await turn(chat.id, 'again');
  assert.match(textOf(second), /\(resumed\)/);
  const argv2 = JSON.parse(await fakeFile('fake-claude-argv.json')) as string[];
  assert.equal(argv2[argv2.indexOf('--resume') + 1], sessionId);
  assert.equal(await fakeFile('fake-claude-prompt.txt'), 'again');
});

function mcpStatus(authorization: string | undefined, extra: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/mcp',
        headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', ...(authorization ? { authorization } : {}), ...extra },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

test('/mcp refuses missing tokens, plugin tokens and browser origins', async () => {
  assert.equal(await mcpStatus(undefined), 401);
  assert.equal(await mcpStatus(`Bearer ${tokens.plugin}`), 401);
  const s = rt.mcp.sessions.create('00000000-0000-4000-8000-000000000001', 'turn', 'cloud');
  try {
    assert.equal(await mcpStatus(`Bearer ${s.token}`), 200);
    assert.equal(await mcpStatus(`Bearer ${s.token}`, { origin: 'lsp://logseq.com' }), 403);
  } finally {
    rt.mcp.sessions.revoke(s);
  }
});

test('claude starting with an unexpected tool is stopped', async () => {
  const chat = await rt.store.create('t2');
  const t0 = Date.now();
  const events = await turn(chat.id, 'FAKE:badtool');
  assert.ok(Date.now() - t0 < 8000, 'killed, not waited for');
  const err = events.find((e) => e.type === 'error');
  assert.match(String(err?.data.message), /did not allow/);
  assert.equal(events.at(-1)?.data.stopReason, 'error');
  assert.equal((await rt.store.get(chat.id))?.claudeSessionId, undefined, 'failed first turn does not save a session');
});

test('cancel kills claude', async () => {
  const chat = await rt.store.create('t3');
  const events: BridgeEvent[] = [];
  rt.turns.eventLog(chat.id).subscribe((e) => events.push(e));
  const { done } = await rt.turns.start(chat.id, { text: 'FAKE:hang', providerId: 'claude', model: 'sonnet', effort: 'auto', contextUuids: [] });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(rt.turns.cancel(chat.id), true);
  await done;
  assert.equal(events.at(-1)?.data.stopReason, 'cancelled');
  const argv = JSON.parse(await fakeFile('fake-claude-argv.json')) as string[];
  assert.ok(!argv.includes('--effort'), 'effort "auto" passes no --effort');
});

test('error results and API-key warnings are surfaced', async () => {
  const chat = await rt.store.create('t4');
  const failed = await turn(chat.id, 'FAKE:error');
  assert.match(String(failed.find((e) => e.type === 'error')?.data.message), /claude: boom/);
  const chat2 = await rt.store.create('t5');
  const warned = await turn(chat2.id, 'FAKE:apikey');
  assert.match(String(warned.find((e) => e.type === 'notice')?.data.message), /API key instead of your Pro plan/);
});

test('page/selection context is filtered before it reaches claude', async () => {
  const chat = await rt.store.create('t6');
  await turn(chat.id, 'what is this?', { context: ['a558ac4e-ae05-43f3-af22-f167c5f56975', 'ef13d15c-eb66-4eb1-ab54-edbae48baa8e'] });
  const prompt = await fakeFile('fake-claude-prompt.txt');
  assert.match(prompt, /<context>[\s\S]*Apples are red[\s\S]*<\/context>/);
  assert.ok(!prompt.includes('secret'), 'the #private block was selected but must not be sent');
  assert.match(prompt, /what is this\?$/);
});

test('switching from a local provider hands over your messages, not local replies', async () => {
  const chat = await rt.store.create('t7');
  await turn(chat.id, 'my first question', { provider: 'echo' });
  await turn(chat.id, 'now with claude');
  const prompt = await fakeFile('fake-claude-prompt.txt');
  assert.match(prompt, /User: my first question/);
  assert.ok(!prompt.includes('You said:'), 'echo (local) reply stays local');
  assert.match(prompt, /now with claude$/);
});

test('the audit log records what went to claude, by id only', async () => {
  const lines = (await readFile(paths.audit, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
  const tool = lines.find((l) => l.kind === 'tool' && l.tool === 'get_page');
  assert.ok(tool);
  assert.equal(tool.locality, 'cloud');
  assert.ok((tool.sentUuids as string[]).includes('a558ac4e-ae05-43f3-af22-f167c5f56975'));
  assert.ok(!JSON.stringify(lines).includes('Apples are red'), 'no note text in the audit log');
  await access(paths.audit);
});

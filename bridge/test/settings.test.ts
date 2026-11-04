import assert from 'node:assert/strict';
import { request } from 'node:http';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { Runtime } from '../src/app.ts';
import type { Tokens } from '../src/auth.ts';
import type { DataPaths } from '../src/config.ts';
import { GraphReader } from '../src/graph/reader.ts';
import { shutdown } from '../src/http/server.ts';
import { Policy } from '../src/policy/policy.ts';
import { autoApproveFrom, Settings } from '../src/settings.ts';
import type { AutoApprove } from '../src/settings.ts';
import type { ToolContext, ToolDef } from '../src/tools/registry.ts';
import { writeTools } from '../src/tools/write.ts';
import { clientRuntime } from './fixtures/client-runtime.ts';
import { FakeLogseq, sampleEntities } from './fixtures/fake-graph.ts';

const OFF: AutoApprove = { writes: false, edits: false, deletes: false };
const ALL: AutoApprove = { writes: true, edits: true, deletes: true };

let rt: Runtime;
let paths: DataPaths;
let port: number;
let tokens: Tokens;
let appToken: string;

before(async () => {
  ({ rt, paths, tokens, token: appToken } = await clientRuntime());
  port = await rt.listen(0);
});

after(async () => {
  await shutdown(rt.server);
});

function http(method: string, path: string, token: string, body?: unknown): Promise<{ status: number; json: any }> {
  const text = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, method, path, headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }) } },
      (res) => {
        let out = '';
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: out ? JSON.parse(out) : null }));
      },
    );
    req.on('error', reject);
    req.end(text);
  });
}

test('the panel reads and saves the boxes; the file is private and the change is logged', async () => {
  const first = await http('GET', '/v1/settings', tokens.plugin);
  assert.equal(first.status, 200);
  assert.deepEqual(first.json.autoApprove, OFF);
  assert.equal(first.json.graph, 'AI Sandbox');

  const value = { writes: true, edits: false, deletes: true };
  const saved = await http('POST', '/v1/settings', tokens.plugin, { autoApprove: value });
  assert.deepEqual(saved.json.autoApprove, value);
  assert.deepEqual((await http('GET', '/v1/settings', tokens.plugin)).json.autoApprove, value);
  assert.equal((await stat(paths.settings)).mode & 0o777, 0o600);
  assert.match(await readFile(paths.audit, 'utf8'), /writes=true edits=false deletes=true/);
});

test('only the panel can change them: not voice, not a connected app, and no tool', async () => {
  const body = { autoApprove: ALL };
  assert.equal((await http('POST', '/v1/settings', tokens.voice, body)).status, 403);
  assert.equal((await http('POST', '/v1/settings', appToken, body)).status, 401);
  const names = ((await rt.mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { client: 'claude-desktop', locality: 'cloud' })).body as any).result.tools.map((t: any) => t.name);
  assert.ok(!names.some((n: string) => /setting|approve/i.test(n)));
});

test('a bad value is refused, not half saved', async () => {
  const before_ = (await http('GET', '/v1/settings', tokens.plugin)).json.autoApprove;
  for (const bad of [undefined, null, 'all', { writes: true }, { writes: 'yes', edits: false, deletes: false }]) {
    assert.equal((await http('POST', '/v1/settings', tokens.plugin, { autoApprove: bad })).status, 400);
  }
  assert.deepEqual((await http('GET', '/v1/settings', tokens.plugin)).json.autoApprove, before_);
});

test('boxes are per graph; a damaged file grants nothing beyond config.json', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lsai-settings-'));
  const file = join(dir, 'settings.json');
  const test_ = new Settings({ file, graph: 'Test', fallback: OFF });
  await test_.setAutoApprove(ALL);
  const other = new Settings({ file, graph: 'Real notes', fallback: OFF });
  assert.equal(await other.saved(), null, 'another graph starts unticked');
  await other.setAutoApprove({ ...OFF, edits: true });
  assert.deepEqual(await test_.saved(), ALL, 'and saving it leaves the first alone');

  await writeFile(file, JSON.stringify({ autoApprove: { Test: { writes: 'yes', edits: 1, deletes: true } } }));
  assert.equal(await test_.saved(), null);
  await writeFile(file, '{ not json');
  assert.equal(await test_.saved(), null);
  assert.deepEqual(await test_.autoApprove(), OFF);
});

test('boxes start from config.json', () => {
  assert.deepEqual(autoApproveFrom('none'), OFF);
  assert.deepEqual(autoApproveFrom('additions'), { writes: true, edits: false, deletes: false });
  assert.deepEqual(autoApproveFrom('own'), { writes: true, edits: false, deletes: false });
  assert.deepEqual(autoApproveFrom('all'), ALL);
});

/** Real write tools with these boxes. Returns whether each change skipped its card. */
async function withBoxes(boxes: AutoApprove | null, autoApply: 'none' | 'additions' | 'all' = 'none') {
  const fake = new FakeLogseq();
  const reader = new GraphReader({ run: fake.run, graph: 'AI Sandbox' });
  const policy = new Policy({ deny: [], allow: [] });
  const runDir = await mkdtemp(join(tmpdir(), 'lsai-boxes-'));
  const tools = writeTools({
    run: fake.run,
    reader,
    policy,
    ensureGraph: async () => {},
    graph: 'AI Sandbox',
    writeGraphs: ['AI Sandbox'],
    runDir,
    autoApply,
    autoApprove: async () => boxes,
    memory: { title: 'AI Memory', invalidate: () => {} },
  });
  const tool = (n: string): ToolDef => tools.find((t) => t.name === n) as ToolDef;
  const seen: boolean[] = [];
  const c: ToolContext = {
    locality: 'cloud',
    chatId: 'c',
    turnId: 't',
    approve: async (req) => {
      seen.push(req.auto === true);
      return { view: { ...req, id: 'x', chatId: 'c', turnId: 't', createdAt: 0 }, decision: { decision: 'reject', reason: 'user' } };
    },
  };
  const auto = async (name: string, args: Record<string, unknown>): Promise<boolean | undefined> => {
    seen.length = 0;
    await tool(name).run(args, c);
    return seen[0];
  };
  return { auto };
}

test('each box covers its own kind of change, and only that', async () => {
  const uuid = sampleEntities().find((e) => e.title.startsWith('Apples'))?.uuid as string;
  const add = { page: 'AI Test', markdown: '- plain text' };
  const edit = { edits: [{ uuid, content: 'Apples are green' }] };
  const del = { uuids: [uuid] };

  const w = await withBoxes({ ...OFF, writes: true });
  assert.deepEqual([await w.auto('insert_blocks', add), await w.auto('update_blocks', edit), await w.auto('remove_blocks', del)], [true, false, false]);
  const e = await withBoxes({ ...OFF, edits: true });
  assert.deepEqual([await e.auto('insert_blocks', add), await e.auto('update_blocks', edit), await e.auto('remove_blocks', del)], [false, true, false]);
  const d = await withBoxes({ ...OFF, deletes: true });
  assert.deepEqual([await d.auto('insert_blocks', add), await d.auto('update_blocks', edit), await d.auto('remove_blocks', del)], [false, false, true]);
});

test('saved boxes replace autoApply; nothing saved leaves it in charge', async () => {
  const add = { page: 'AI Test', markdown: '- plain text' };
  assert.equal(await (await withBoxes(OFF, 'additions')).auto('insert_blocks', add), false, 'unticking wins over config.json');
  assert.equal(await (await withBoxes(null, 'additions')).auto('insert_blocks', add), true);
});

test('a warning still gets the card, and memory never skips it, with every box ticked', async () => {
  const b = await withBoxes(ALL);
  assert.equal(await b.auto('insert_blocks', { page: 'AI Test', markdown: '- see https://example.com/x' }), false);
  assert.equal(await b.auto('insert_blocks', { page: 'AI Test', markdown: '- ![x](https://example.com/a.png)' }), false);
  assert.equal(await b.auto('remember', { text: 'Likes tea' }), false);
});

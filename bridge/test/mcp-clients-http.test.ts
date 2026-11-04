import assert from 'node:assert/strict';
import { request } from 'node:http';
import { PassThrough } from 'node:stream';
import { after, before, test } from 'node:test';
import type { Runtime } from '../src/app.ts';
import { shutdown } from '../src/http/server.ts';
import { APPS_CHAT_ID } from '../src/mcp/clients.ts';
import { BRIDGE_DOWN, NOT_CONNECTED, runStdio } from '../src/mcp/stdio.ts';
import { clientRuntime } from './fixtures/client-runtime.ts';

let rt: Runtime;
let port: number;
let token: string;
let tokens: { plugin: string };

before(async () => {
  ({ rt, token, tokens } = await clientRuntime());
  port = await rt.listen(0);
});

after(async () => {
  await shutdown(rt.server);
});

function status(auth: string | undefined, extra: Record<string, string> = {}): Promise<number> {
  const text = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' });
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/mcp',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text), ...(auth ? { authorization: `Bearer ${auth}` } : {}), ...extra },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', reject);
    req.end(text);
  });
}

async function stdio(lines: unknown[], o: { port: number; token: string }): Promise<any[]> {
  const input = new PassThrough();
  const output = new PassThrough();
  let out = '';
  output.on('data', (c) => (out += c));
  const done = runStdio({ port: o.port, token: async () => o.token, input, output });
  for (const l of lines) input.write(`${JSON.stringify(l)}\n`);
  input.end();
  await done;
  return out.trim() === '' ? [] : out.trim().split('\n').map((l) => JSON.parse(l));
}

test('/mcp accepts a connected app, and refuses wrong tokens and browser pages', async () => {
  assert.equal(await status(token), 200);
  assert.equal(await status(undefined), 401);
  assert.equal(await status('x'.repeat(43)), 401);
  assert.equal(await status(token, { origin: 'lsp://logseq.com' }), 403);
});

test('stdio: requests are relayed one line each, and notifications get no answer', async () => {
  const replies = await stdio(
    [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    ],
    { port, token },
  );
  assert.deepEqual(replies.map((r) => r.id).sort(), [1, 2]);
  assert.ok(replies.find((r) => r.id === 2).result.tools.length > 0);
});

test('the apps chat stays out of the chat list', async () => {
  const body = await new Promise<string>((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/v1/chats', headers: { authorization: `Bearer ${tokens.plugin}` } }, (res) => {
      let out = '';
      res.on('data', (c) => (out += c));
      res.on('end', () => resolve(out));
    });
    req.on('error', reject);
    req.end();
  });
  assert.deepEqual(JSON.parse(body).chats, []);
  assert.ok(await rt.store.get(APPS_CHAT_ID), 'but it exists, so a panel can follow it');
});

test('stdio: clear errors when the bridge is down or refuses the token', async () => {
  const req = { jsonrpc: '2.0', id: 7, method: 'tools/list' };
  assert.equal((await stdio([req], { port: 1, token }))[0].error.message, BRIDGE_DOWN);
  assert.equal((await stdio([req], { port, token: 'y'.repeat(43) }))[0].error.message, NOT_CONNECTED);
});

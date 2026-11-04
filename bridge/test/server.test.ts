import assert from 'node:assert/strict';
import { request } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { loadOrCreateTokens } from '../src/auth.ts';
import type { Tokens } from '../src/auth.ts';
import { AuditLog } from '../src/audit.ts';
import { ChatStore } from '../src/chats/store.ts';
import { TurnRunner } from '../src/chats/turns.ts';
import { dataPaths, ensureDataDirs } from '../src/config.ts';
import { createBridgeServer, listen, shutdown } from '../src/http/server.ts';
import type { Server } from 'node:http';
import { EchoProvider } from '../src/providers/echo.ts';

const ORIGIN = 'lsp://logseq.com';
let server: Server;
let port: number;
let tokens: Tokens;

type Res = { status: number; headers: IncomingHttpHeaders; body: string; json: any };

function call(method: string, path: string, opts: { headers?: Record<string, string>; body?: unknown; rawBody?: string } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined);
    const headers: Record<string, string> = { host: `127.0.0.1:${port}`, ...(opts.headers ?? {}) };
    if (payload !== undefined && !headers['content-type']) headers['content-type'] = 'application/json';
    const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        try {
          json = JSON.parse(body);
        } catch {
          json = null;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

const auth = (): Record<string, string> => ({ authorization: `Bearer ${tokens.plugin}` });

/** Reads SSE frames until an event of type `until` arrives. */
function readSse(path: string, until: string, timeoutMs = 5000): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const events: any[] = [];
    const req = request(
      { host: '127.0.0.1', port, method: 'GET', path, headers: { host: `127.0.0.1:${port}`, accept: 'text/event-stream', origin: ORIGIN, ...auth() } },
      (res) => {
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['access-control-allow-origin'], ORIGIN);
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          buf += chunk;
          let i: number;
          while ((i = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const data = frame.split('\n').find((l) => l.startsWith('data: '));
            if (!data) continue;
            const ev = JSON.parse(data.slice(6));
            events.push(ev);
            if (ev.type === until) {
              req.destroy();
              resolve(events);
              return;
            }
          }
        });
      },
    );
    req.on('error', (err) => {
      if (events.at(-1)?.type !== until) reject(err);
    });
    setTimeout(() => {
      req.destroy();
      reject(new Error(`timeout waiting for ${until}; got ${events.map((e) => e.type).join(',')}`));
    }, timeoutMs);
    req.end();
  });
}

before(async () => {
  const root = await mkdtemp(join(tmpdir(), 'lsai-srv-'));
  const paths = dataPaths(root);
  await ensureDataDirs(paths);
  tokens = await loadOrCreateTokens(paths.tokens);
  const store = new ChatStore(paths.chats);
  const turns = new TurnRunner({ store, providers: [new EchoProvider(1)], audit: new AuditLog(paths.audit), epoch: 'test-epoch' });
  server = createBridgeServer({ port: 0, allowedOrigins: [ORIGIN], tokens, store, turns });
  port = await listen(server, 0);
});

after(async () => {
  await shutdown(server);
});

test('rejects a wrong Host header (DNS rebinding)', async () => {
  const r = await call('GET', '/v1/health', { headers: { host: `localhost:${port}` } });
  assert.equal(r.status, 403);
  const r2 = await call('GET', '/v1/health', { headers: { host: `evil.example:${port}` } });
  assert.equal(r2.status, 403);
});

test('rejects unknown origins, accepts the plugin origin', async () => {
  const bad = await call('GET', '/v1/health', { headers: { origin: 'https://evil.example', ...auth() } });
  assert.equal(bad.status, 403);
  assert.equal(bad.headers['access-control-allow-origin'], undefined);
  const nul = await call('GET', '/v1/health', { headers: { origin: 'null', ...auth() } });
  assert.equal(nul.status, 403);
  const ok = await call('GET', '/v1/health', { headers: { origin: ORIGIN, ...auth() } });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['access-control-allow-origin'], ORIGIN);
});

test('preflight only for allowed origins, includes private-network header', async () => {
  const ok = await call('OPTIONS', '/v1/chats', {
    headers: { origin: ORIGIN, 'access-control-request-method': 'POST', 'access-control-request-private-network': 'true' },
  });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers['access-control-allow-private-network'], 'true');
  assert.match(String(ok.headers['access-control-allow-headers']), /Authorization/);
  const bad = await call('OPTIONS', '/v1/chats', { headers: { origin: 'https://evil.example' } });
  assert.equal(bad.status, 403);
});

test('health without a token is minimal; everything else needs one', async () => {
  const h = await call('GET', '/v1/health');
  assert.equal(h.status, 200);
  assert.deepEqual(Object.keys(h.json).sort(), ['name', 'ok']);
  assert.equal((await call('GET', '/v1/chats')).status, 401);
  assert.equal((await call('GET', '/v1/chats', { headers: { authorization: 'Bearer ' + 'x'.repeat(43) } })).status, 401);
  const full = await call('GET', '/v1/health', { headers: auth() });
  assert.equal(full.json.scope, 'plugin');
});

test('voice token cannot use plugin routes', async () => {
  const r = await call('GET', '/v1/chats', { headers: { authorization: `Bearer ${tokens.voice}` } });
  assert.equal(r.status, 403);
});

test('body checks: content type, size, JSON shape', async () => {
  assert.equal((await call('POST', '/v1/chats', { headers: { ...auth(), 'content-type': 'text/plain' }, rawBody: '{}' })).status, 415);
  assert.equal((await call('POST', '/v1/chats', { headers: auth(), rawBody: '{nope' })).status, 400);
  assert.equal((await call('POST', '/v1/chats', { headers: auth(), rawBody: '[1,2]' })).status, 400);
  // The server refuses an oversized body before reading all of it. Depending on the OS the client
  // either reads the 413 or gets a reset while still uploading (macOS); both mean "refused".
  const big = await call('POST', '/v1/chats', { headers: auth(), rawBody: JSON.stringify({ title: 'x'.repeat(2 * 1024 * 1024) }) }).then(
    (r) => r.status,
    (e: NodeJS.ErrnoException) => (e.code === 'ECONNRESET' || e.code === 'EPIPE' ? 'reset' : Promise.reject(e)),
  );
  assert.ok(big === 413 || big === 'reset', `got ${big}`);
  assert.equal((await call('GET', '/v1/health')).status, 200, 'server still healthy');
});

test('chat ids are validated (no path traversal)', async () => {
  assert.equal((await call('GET', '/v1/chats/..%2F..%2Fsecrets%2Ftokens', { headers: auth() })).status, 404);
  assert.equal((await call('GET', '/v1/chats/not-a-uuid', { headers: auth() })).status, 404);
  assert.equal((await call('GET', '/v1/chats/00000000-0000-4000-8000-000000000000', { headers: auth() })).status, 404);
});

test('end to end: create chat, stream an echo turn over SSE, transcript stored', async () => {
  const created = await call('POST', '/v1/chats', { headers: auth(), body: { title: 'Test' } });
  assert.equal(created.status, 201);
  const chatId: string = created.json.chat.id;

  const streamed = readSse(`/v1/chats/${chatId}/events?after=0`, 'turn.end');
  await new Promise((r) => setTimeout(r, 50));
  const sent = await call('POST', `/v1/chats/${chatId}/messages`, {
    headers: auth(),
    body: { text: 'hello there', provider: 'echo', effort: 'auto', context: { blockUuids: ['6F9619FF-8B86-D011-B42D-00C04FC964FF'] } },
  });
  assert.equal(sent.status, 202, sent.body);
  // The first frame gives the bridge's epoch, so a panel notices a restart even in a quiet chat.
  const [hello, ...events] = await streamed;
  assert.equal(hello.type, 'log.hello');
  assert.equal(hello.epoch, created.json.epoch ?? hello.epoch);
  assert.ok(hello.epoch);
  const types = events.map((e) => e.type);
  assert.equal(types[0], 'turn.start');
  assert.equal(types.at(-1), 'turn.end');
  const text = events.filter((e) => e.type === 'text.delta').map((e) => e.data.text).join('');
  assert.equal(text, 'You said: hello there');
  assert.ok(events.every((e, i) => i === 0 || e.seq > events[i - 1].seq));

  const chat = await call('GET', `/v1/chats/${chatId}`, { headers: auth() });
  assert.equal(chat.json.messages.length, 2);
  assert.equal(chat.json.messages[0].role, 'user');
  assert.deepEqual(chat.json.messages[0].meta.contextUuids, ['6f9619ff-8b86-d011-b42d-00c04fc964ff']);
  assert.equal(chat.json.messages[1].parts[0].text, 'You said: hello there');

  // Long-poll fallback returns the same events.
  const polled = await call('GET', `/v1/chats/${chatId}/events?after=0`, { headers: auth() });
  assert.equal(polled.json.events.length, events.length);
  const tail = await call('GET', `/v1/chats/${chatId}/events?after=${polled.json.lastSeq}&wait=1`, { headers: auth() });
  assert.equal(tail.json.events.length, 0);
});

test('validation: unknown provider, bad effort, bad context, busy chat, cancel', async () => {
  const chatId: string = (await call('POST', '/v1/chats', { headers: auth(), body: {} })).json.chat.id;
  const base = { headers: auth() };
  assert.equal((await call('POST', `/v1/chats/${chatId}/messages`, { ...base, body: { text: 'x', provider: 'nope' } })).status, 400);
  assert.equal((await call('POST', `/v1/chats/${chatId}/messages`, { ...base, body: { text: 'x', provider: 'echo', effort: 'ultra' } })).status, 400);
  assert.equal((await call('POST', `/v1/chats/${chatId}/messages`, { ...base, body: { text: 'x', provider: 'echo', effort: 'high' } })).status, 400);
  assert.equal((await call('POST', `/v1/chats/${chatId}/messages`, { ...base, body: { text: 'x', provider: 'echo', context: { blockUuids: ['../x'] } } })).status, 400);
  assert.equal((await call('POST', `/v1/chats/${chatId}/messages`, { ...base, body: { text: '   ', provider: 'echo' } })).status, 400);

  const long = 'word '.repeat(400);
  assert.equal((await call('POST', `/v1/chats/${chatId}/messages`, { ...base, body: { text: long, provider: 'echo' } })).status, 202);
  assert.equal((await call('POST', `/v1/chats/${chatId}/messages`, { ...base, body: { text: 'again', provider: 'echo' } })).status, 409);
  const cancel = await call('POST', `/v1/chats/${chatId}/cancel`, { ...base, body: {} });
  assert.equal(cancel.json.cancelled, true);
  const events = await readSse(`/v1/chats/${chatId}/events?after=0`, 'turn.end');
  assert.equal(events.at(-1).data.stopReason, 'cancelled');
});

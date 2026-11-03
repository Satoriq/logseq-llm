import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { bearerFrom, scopeForToken } from '../auth.ts';
import type { Scope, Tokens } from '../auth.ts';
import { ChatStore, isChatId } from '../chats/store.ts';
import { TurnError, TurnRunner } from '../chats/turns.ts';
import { BRIDGE_NAME, BRIDGE_VERSION } from '../config.ts';
import { sseFrame } from '../events.ts';
import { log } from '../log.ts';
import { isEffort } from '../providers/types.ts';
import type { McpEndpoint } from '../mcp/endpoint.ts';

/**
 * HTTP API on 127.0.0.1. Checks, in order, for every request:
 *  1. Host header must be exactly 127.0.0.1:<port>  (DNS-rebinding defense)
 *  2. Origin, when present, must be in allowedOrigins (exact match)
 *  3. CORS preflight answered only for allowed origins
 *  4. Bearer token with the right scope (except the minimal /v1/health)
 *  5. JSON bodies only, max 1 MB
 */

export type ServerDeps = {
  port: number;
  allowedOrigins: readonly string[];
  tokens: Tokens;
  store: ChatStore;
  turns: TurnRunner;
  /** MCP endpoint for `claude -p` (per-process tokens). Optional so tests can omit it. */
  mcp?: McpEndpoint;
};

const MAX_BODY = 1024 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SSE_HEARTBEAT_MS = 15000;
const MAX_LONG_POLL_S = 25;

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(text);
}

function corsHeaders(origin: string | undefined): Record<string, string> {
  if (!origin) return {};
  return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'Content-Type must be application/json');
  const declared = Number(req.headers['content-length'] ?? '0');
  if (declared > MAX_BODY) throw new HttpError(413, 'body too large');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY) throw new HttpError(413, 'body too large');
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
}

function optionalString(body: Record<string, unknown>, key: string, max: number): string | undefined {
  const v = body[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new HttpError(400, `"${key}" must be a string`);
  if (v.length > max) throw new HttpError(400, `"${key}" is too long`);
  return v;
}

function parseContext(body: Record<string, unknown>): string[] {
  const ctx = body.context;
  if (ctx === undefined || ctx === null) return [];
  if (typeof ctx !== 'object' || Array.isArray(ctx)) throw new HttpError(400, '"context" must be an object');
  const c = ctx as Record<string, unknown>;
  const out: string[] = [];
  if (c.pageUuid !== undefined && c.pageUuid !== null) {
    if (typeof c.pageUuid !== 'string' || !UUID_RE.test(c.pageUuid)) throw new HttpError(400, '"context.pageUuid" must be a UUID');
    out.push(c.pageUuid.toLowerCase());
  }
  if (c.blockUuids !== undefined) {
    if (!Array.isArray(c.blockUuids) || c.blockUuids.length > 200) throw new HttpError(400, '"context.blockUuids" must be an array (max 200)');
    for (const u of c.blockUuids) {
      if (typeof u !== 'string' || !UUID_RE.test(u)) throw new HttpError(400, '"context.blockUuids" must contain UUIDs');
      out.push(u.toLowerCase());
    }
  }
  return [...new Set(out)];
}

export function createBridgeServer(deps: ServerDeps): Server {
  const allowed = new Set(deps.allowedOrigins);

  const server = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError || err instanceof TurnError ? err.status : 500;
      if (status === 500) log.error('request failed', { path: req.url, error: (err as Error).message });
      if (!res.headersSent) {
        const headers = corsHeaders(allowedOrigin(req));
        // If we stopped before reading the whole body, don't let the client reuse this socket.
        if (!req.complete) headers.Connection = 'close';
        send(res, status, { error: status === 500 ? 'internal error' : (err as Error).message }, headers);
      } else {
        res.end();
      }
    });
  });

  function actualPort(): number {
    const addr = server.address() as AddressInfo | null;
    return addr ? addr.port : deps.port;
  }

  function allowedOrigin(req: IncomingMessage): string | undefined {
    const o = req.headers.origin;
    return o !== undefined && allowed.has(o) ? o : undefined;
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = Date.now();
    res.on('finish', () => {
      log.debug('http', { method: req.method, path: (req.url ?? '').split('?')[0], status: res.statusCode, ms: Date.now() - started });
    });

    // 1. Host
    if (req.headers.host !== `127.0.0.1:${actualPort()}`) {
      throw new HttpError(403, 'bad host');
    }
    // 2. Origin
    const origin = req.headers.origin;
    if (origin !== undefined && !allowed.has(origin)) {
      log.warn('rejected origin', { origin });
      throw new HttpError(403, 'origin not allowed');
    }
    const cors = corsHeaders(origin);

    // 3. Preflight
    if (req.method === 'OPTIONS') {
      if (!origin) throw new HttpError(403, 'preflight without origin');
      const headers: Record<string, string> = {
        ...cors,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type, Accept',
        'Access-Control-Max-Age': '600',
      };
      // Chromium's Private/Local Network Access preflight.
      if (req.headers['access-control-request-private-network'] === 'true') {
        headers['Access-Control-Allow-Private-Network'] = 'true';
      }
      res.writeHead(204, headers);
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://127.0.0.1:${actualPort()}`);
    const parts = url.pathname.split('/').filter((p) => p !== '');

    // MCP endpoint for claude: its own per-process tokens, never reachable from a browser page.
    if (url.pathname === '/mcp') {
      if (origin !== undefined) throw new HttpError(403, 'no browser access to /mcp');
      const session = deps.mcp?.sessions.find(bearerFrom(req.headers.authorization)) ?? null;
      if (!deps.mcp || !session) throw new HttpError(401, 'missing or invalid token');
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST' });
        res.end();
        return;
      }
      const reply = await deps.mcp.handle(await readJson(req), session);
      if (reply.body === undefined) {
        res.writeHead(reply.status);
        res.end();
      } else {
        send(res, reply.status, reply.body);
      }
      return;
    }

    // Minimal health check without a token (no graph data, no chat data).
    if (req.method === 'GET' && url.pathname === '/v1/health' && !req.headers.authorization) {
      send(res, 200, { ok: true, name: BRIDGE_NAME }, cors);
      return;
    }

    // 4. Token
    const scope = scopeForToken(bearerFrom(req.headers.authorization), deps.tokens);
    if (!scope) throw new HttpError(401, 'missing or invalid token');

    await route(req, res, url, parts, scope, cors);
  }

  function requireScope(scope: Scope, needed: Scope): void {
    if (scope !== needed) throw new HttpError(403, 'token scope does not allow this');
  }

  async function route(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    parts: string[],
    scope: Scope,
    cors: Record<string, string>,
  ): Promise<void> {
    const method = req.method ?? 'GET';
    const [v, a, id, b] = parts;
    if (v !== 'v1') throw new HttpError(404, 'not found');

    if (method === 'GET' && a === 'health' && parts.length === 2) {
      send(res, 200, { ok: true, name: BRIDGE_NAME, version: BRIDGE_VERSION, epoch: deps.turns.epoch, scope }, cors);
      return;
    }

    if (method === 'GET' && a === 'providers' && parts.length === 2) {
      requireScope(scope, 'plugin');
      const list = [];
      for (const p of deps.turns.providers()) {
        list.push({ id: p.id, label: p.label, locality: p.locality, models: await p.models() });
      }
      send(res, 200, { providers: list }, cors);
      return;
    }

    if (a === 'chats') {
      requireScope(scope, 'plugin');
      if (parts.length === 2) {
        if (method === 'GET') {
          send(res, 200, { chats: await deps.store.list() }, cors);
          return;
        }
        if (method === 'POST') {
          const body = await readJson(req);
          const chat = await deps.store.create(optionalString(body, 'title', 200));
          send(res, 201, { chat }, cors);
          return;
        }
      }
      if (id === undefined || !isChatId(id)) throw new HttpError(404, 'chat not found');
      const chat = await deps.store.get(id);
      if (!chat) throw new HttpError(404, 'chat not found');

      if (parts.length === 3 && method === 'GET') {
        send(res, 200, { chat, messages: await deps.store.messages(id), busy: deps.turns.isBusy(id), lastSeq: deps.turns.eventLog(id).lastSeq, epoch: deps.turns.epoch }, cors);
        return;
      }
      if (parts.length === 4 && b === 'messages' && method === 'POST') {
        const body = await readJson(req);
        const text = optionalString(body, 'text', 100_000);
        if (!text || text.trim() === '') throw new HttpError(400, '"text" is required');
        const providerId = optionalString(body, 'provider', 64);
        if (!providerId) throw new HttpError(400, '"provider" is required');
        const effort = body.effort ?? 'auto';
        if (!isEffort(effort)) throw new HttpError(400, '"effort" is not a known level');
        const model = optionalString(body, 'model', 128);
        const { turnId } = await deps.turns.start(id, {
          text,
          providerId,
          effort,
          contextUuids: parseContext(body),
          ...(model !== undefined ? { model } : {}),
        });
        send(res, 202, { turnId }, cors);
        return;
      }
      if (parts.length === 4 && b === 'cancel' && method === 'POST') {
        send(res, 200, { cancelled: deps.turns.cancel(id) }, cors);
        return;
      }
      if (parts.length === 4 && b === 'events' && method === 'GET') {
        await events(req, res, url, id, cors);
        return;
      }
    }

    throw new HttpError(404, 'not found');
  }

  async function events(req: IncomingMessage, res: ServerResponse, url: URL, chatId: string, cors: Record<string, string>): Promise<void> {
    const afterRaw = url.searchParams.get('after') ?? '0';
    if (!/^\d{1,12}$/.test(afterRaw)) throw new HttpError(400, '"after" must be a non-negative integer');
    const after = Number(afterRaw);
    const log_ = deps.turns.eventLog(chatId);
    const wantsSse = (req.headers.accept ?? '').includes('text/event-stream');

    if (!wantsSse) {
      // Long-poll fallback (works through logseq.Request, which can't stream).
      const waitRaw = url.searchParams.get('wait') ?? '0';
      if (!/^\d{1,3}$/.test(waitRaw)) throw new HttpError(400, '"wait" must be seconds');
      const wait = Math.min(Number(waitRaw), MAX_LONG_POLL_S);
      if (wait > 0) {
        const ac = new AbortController();
        req.on('close', () => ac.abort());
        await log_.waitForNew(after, wait * 1000, ac.signal);
      }
      const { events: list, gap } = log_.since(after);
      send(res, 200, { epoch: log_.epoch, events: list, gap, lastSeq: log_.lastSeq }, cors);
      return;
    }

    res.writeHead(200, {
      ...cors,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const { events: backlog, gap } = log_.since(after);
    res.write(`retry: 2000\n\n`);
    if (gap) res.write(`data: ${JSON.stringify({ type: 'log.gap', epoch: log_.epoch, seq: 0 })}\n\n`);
    for (const ev of backlog) res.write(sseFrame(ev));
    const unsubscribe = log_.subscribe((ev) => {
      res.write(sseFrame(ev));
    });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), SSE_HEARTBEAT_MS);
    const close = (): void => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.on('close', close);
    res.on('close', close);
  }

  return server;
}

/** Stops accepting requests and ends open SSE streams and keep-alive connections. */
export function shutdown(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
}

/** Starts listening on 127.0.0.1 only. */
export function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port, exclusive: true }, () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
}

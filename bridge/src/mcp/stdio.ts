import { request } from 'node:http';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

/**
 * MCP over stdio, for apps that start a local program (Claude Desktop, Codex). Every JSON-RPC
 * line goes to the running bridge's /mcp with this app's token, and the answer comes back as
 * one line. There's no logic here on purpose: the tools and the privacy filter stay in the
 * bridge, and this program never touches the graph.
 */

export const BRIDGE_DOWN = "The Logseq AI bridge isn't running. Start it with: node bin/logseq-ai-bridge.ts agent restart";
export const NOT_CONNECTED = 'This app has no valid Logseq AI token. Run: node bin/logseq-ai-bridge.ts connect <app>';

type Answer = { status: number; text: string };

/** node:http rather than fetch: fetch gives up on a response after 5 minutes. */
function post(port: number, token: string, body: string): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/mcp',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

export async function runStdio(o: { port: number; token: () => Promise<string | undefined>; input: Readable; output: Writable }): Promise<void> {
  const send = (message: unknown): void => {
    o.output.write(`${JSON.stringify(message)}\n`);
  };
  const fail = (id: unknown, code: number, message: string): void => send({ jsonrpc: '2.0', id, error: { code, message } });

  const forward = async (line: string): Promise<void> => {
    let id: unknown;
    try {
      id = (JSON.parse(line) as { id?: unknown } | null)?.id;
    } catch {
      return fail(null, -32700, 'not valid JSON');
    }
    // Notifications have no id and get no answer, whatever happens to them.
    const answer = (message: string): void => {
      if (id !== undefined) fail(id, -32000, message);
    };
    const token = await o.token();
    if (!token) return answer(NOT_CONNECTED);
    let reply: Answer;
    try {
      reply = await post(o.port, token, line);
    } catch {
      return answer(BRIDGE_DOWN);
    }
    if (reply.status === 401) return answer(NOT_CONNECTED);
    if (id === undefined) return;
    try {
      const parsed = JSON.parse(reply.text) as { jsonrpc?: unknown } | null;
      if (parsed?.jsonrpc === '2.0') return send(parsed);
    } catch {
      // Not JSON-RPC: answered below.
    }
    answer(`The bridge answered with status ${reply.status}.`);
  };

  // Requests run side by side, so a slow tool call doesn't hold up a ping.
  const pending = new Set<Promise<void>>();
  for await (const line of createInterface({ input: o.input, crlfDelay: Infinity })) {
    if (line.trim() === '') continue;
    const p: Promise<void> = forward(line).finally(() => pending.delete(p));
    pending.add(p);
  }
  await Promise.all(pending);
}

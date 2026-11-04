import { createServer } from 'node:http';
import type { Server } from 'node:http';

export type FakeReply = { thinking?: string; content?: string; toolCalls?: { name: string; arguments: unknown }[]; doneReason?: string };

/** A stand-in for Ollama's HTTP API: scripted replies, and a record of every /api/chat body. */
export class FakeOllama {
  readonly chats: any[] = [];
  /** One entry per /api/chat call. When they run out, the last one repeats. */
  script: FakeReply[] = [];
  /** Answer /api/chat with this status and a JSON error. */
  failWith: { status: number; error: string } | null = null;
  /** Never finish /api/chat (to test Stop). */
  hang = false;
  tags: { name: string; remote_host?: string }[] = [{ name: 'gemma4:12b' }];
  shows: Record<string, unknown> = { 'gemma4:12b': { capabilities: ['completion', 'tools', 'thinking'], thinking: { values: [true, false] } } };
  #server: Server | null = null;

  async start(): Promise<string> {
    this.#server = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (req.url === '/api/tags') return void res.end(JSON.stringify({ models: this.tags }));
        if (req.url === '/api/show') return void res.end(JSON.stringify(this.shows[(JSON.parse(body) as { model: string }).model] ?? {}));
        if (req.url !== '/api/chat') return void res.writeHead(404).end('{}');
        this.chats.push(JSON.parse(body));
        if (this.failWith) return void res.writeHead(this.failWith.status).end(JSON.stringify({ error: this.failWith.error }));
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        if (this.hang) return void res.write(`${JSON.stringify({ message: { content: 'Working' } })}\n`);
        const r = this.script[Math.min(this.chats.length - 1, this.script.length - 1)] ?? { content: '' };
        const line = (o: unknown): void => void res.write(`${JSON.stringify(o)}\n`);
        if (r.thinking) line({ message: { role: 'assistant', content: '', thinking: r.thinking } });
        for (const w of (r.content ?? '').split(/(?<= )/)) if (w) line({ message: { role: 'assistant', content: w } });
        if (r.toolCalls) line({ message: { role: 'assistant', content: '', tool_calls: r.toolCalls.map((c) => ({ function: c })) } });
        line({ done: true, done_reason: r.doneReason ?? 'stop', prompt_eval_count: 100, eval_count: 10 });
        res.end();
      });
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, '127.0.0.1', resolve));
    const a = this.#server.address() as { port: number };
    return `http://127.0.0.1:${a.port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.#server?.closeAllConnections();
      this.#server?.close(() => resolve());
    });
  }
}

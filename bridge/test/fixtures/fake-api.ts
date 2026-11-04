import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';

/** A stand-in for a cloud API: scripted SSE, and a record of what was sent. */
export class FakeApi {
  readonly requests: { headers: IncomingHttpHeaders; body: any }[] = [];
  /** The data objects of one reply, per request. When they run out, the last one repeats. */
  script: unknown[][] = [];
  /** Answered first, one per request, instead of a stream. */
  failures: { status: number; body?: unknown; headers?: Record<string, string> }[] = [];
  /** Keep the stream open after the script (to test Stop). */
  hang = false;
  #server: Server | null = null;

  reset(): void {
    this.requests.length = 0;
    this.script = [];
    this.failures = [];
    this.hang = false;
  }

  async start(): Promise<string> {
    this.#server = createServer((req, res) => {
      let text = '';
      req.on('data', (c) => (text += c));
      req.on('end', () => {
        this.requests.push({ headers: req.headers, body: JSON.parse(text) });
        const fail = this.failures.shift();
        if (fail) return void res.writeHead(fail.status, fail.headers ?? {}).end(JSON.stringify(fail.body ?? {}));
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const events = this.script[Math.min(this.requests.length - 1, this.script.length - 1)] ?? [];
        for (const e of events) res.write(`event: x\ndata: ${JSON.stringify(e)}\n\n`);
        if (!this.hang) res.end();
      });
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.#server.address() as { port: number }).port}`;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => {
      this.#server?.closeAllConnections();
      this.#server?.close(() => resolve());
    });
  }
}

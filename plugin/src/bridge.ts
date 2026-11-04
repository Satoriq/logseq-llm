import type { BridgeEvent, ChatMeta, ChatState, Effort, InstructionsState, ProviderInfo } from './types';

/**
 * Client for the local bridge.
 * - direct: fetch from the plugin iframe to http://127.0.0.1:<port>, events streamed over SSE.
 * - proxy:  if direct fetch is blocked (e.g. Chromium's Local Network Access rules), requests
 *           go through logseq.Net (the Logseq app makes them), and events are long-polled.
 */

export type HttpResult = { status: number; json: unknown };
export type ProxyRequest = (o: { url: string; method: string; headers: Record<string, string>; body?: string; timeoutMs: number }) => Promise<HttpResult>;

export class BridgeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type ConnState = { state: 'connecting' | 'live' | 'retrying'; mode: 'direct' | 'proxy'; error?: string };

export type SendInput = {
  text: string;
  provider: string;
  model: string;
  effort: Effort;
  context: { pageUuid?: string; blockUuids?: string[] };
  /** Let the model search the web for this message. */
  web?: boolean;
};

export class BridgeClient {
  readonly baseUrl: string;
  mode: 'direct' | 'proxy' = 'direct';
  #token: string;
  #proxy: ProxyRequest | undefined;
  #fetch: typeof fetch;

  constructor(opts: { baseUrl: string; token: string; proxy?: ProxyRequest; fetchImpl?: typeof fetch }) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.#token = opts.token.trim();
    this.#proxy = opts.proxy;
    this.#fetch = opts.fetchImpl ?? fetch.bind(globalThis);
  }

  #headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.#token}`, ...extra };
  }

  async #call<T>(method: string, path: string, body?: unknown, timeoutMs = 20_000): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const headers = this.#headers(body !== undefined ? { 'Content-Type': 'application/json' } : {});
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    let res: HttpResult;
    if (this.mode === 'direct') {
      try {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), timeoutMs);
        const r = await this.#fetch(url, { method, headers, ...(payload !== undefined ? { body: payload } : {}), signal: ac.signal });
        clearTimeout(t);
        const text = await r.text();
        res = { status: r.status, json: text ? safeJson(text) : null };
      } catch (err) {
        // A TypeError here means the request never got an HTTP answer (bridge down, or blocked).
        if (err instanceof TypeError && this.#proxy) {
          this.mode = 'proxy';
          return this.#call(method, path, body, timeoutMs);
        }
        throw new BridgeError(0, `cannot reach the bridge at ${this.baseUrl} (${(err as Error).message})`);
      }
    } else {
      const proxy = this.#proxy;
      if (!proxy) throw new BridgeError(0, 'no proxy transport');
      try {
        res = await proxy({ url, method, headers, ...(payload !== undefined ? { body: payload } : {}), timeoutMs });
      } catch (err) {
        throw new BridgeError(0, `cannot reach the bridge at ${this.baseUrl} (${(err as Error).message})`);
      }
    }
    if (res.status < 200 || res.status >= 300) {
      const msg = (res.json as { error?: unknown } | null)?.error;
      throw new BridgeError(res.status, typeof msg === 'string' ? msg : `HTTP ${res.status}`);
    }
    return res.json as T;
  }

  health(): Promise<{ ok: boolean; version?: string; scope?: string }> {
    return this.#call('GET', '/v1/health');
  }

  async providers(): Promise<ProviderInfo[]> {
    return (await this.#call<{ providers: ProviderInfo[] }>('GET', '/v1/providers')).providers;
  }

  async chats(): Promise<ChatMeta[]> {
    return (await this.#call<{ chats: ChatMeta[] }>('GET', '/v1/chats')).chats;
  }

  async createChat(title: string): Promise<ChatMeta> {
    return (await this.#call<{ chat: ChatMeta }>('POST', '/v1/chats', { title })).chat;
  }

  chat(id: string): Promise<ChatState> {
    return this.#call('GET', `/v1/chats/${encodeURIComponent(id)}`);
  }

  send(id: string, input: SendInput): Promise<{ turnId: string }> {
    return this.#call('POST', `/v1/chats/${encodeURIComponent(id)}/messages`, input);
  }

  decide(approvalId: string, decision: 'apply' | 'reject' | 'apply-all' | 'abort', note?: string): Promise<{ ok: boolean }> {
    return this.#call('POST', `/v1/approvals/${encodeURIComponent(approvalId)}`, { decision, ...(note ? { note } : {}) });
  }

  instructions(): Promise<InstructionsState> {
    return this.#call('GET', '/v1/instructions');
  }

  saveInstructions(text: string): Promise<InstructionsState> {
    return this.#call('POST', '/v1/instructions', { text });
  }

  cancel(id: string): Promise<{ cancelled: boolean }> {
    return this.#call('POST', `/v1/chats/${encodeURIComponent(id)}/cancel`, {});
  }

  /**
   * Follows a chat's events from `after`. Reconnects with backoff and resumes from the last
   * seq it saw, so nothing is lost. Returns a function that stops it.
   */
  subscribe(chatId: string, after: number, onEvent: (ev: BridgeEvent) => void, onState: (s: ConnState) => void): () => void {
    let last = after;
    let stopped = false;
    let backoff = 1000;
    let ac: AbortController | null = null;
    // caps=approvals tells the bridge this panel can show approval cards (otherwise writes fail fast).
    const path = (wait: number): string => `/v1/chats/${encodeURIComponent(chatId)}/events?after=${last}&caps=approvals${wait ? `&wait=${wait}` : ''}`;
    const deliver = (ev: BridgeEvent): void => {
      if (typeof ev.seq === 'number' && ev.seq > last) last = ev.seq;
      onEvent(ev);
    };

    const runDirect = async (): Promise<void> => {
      ac = new AbortController();
      const r = await this.#fetch(`${this.baseUrl}${path(0)}`, { headers: this.#headers({ Accept: 'text/event-stream' }), signal: ac.signal });
      if (!r.ok || !r.body) throw new BridgeError(r.status, `event stream failed (HTTP ${r.status})`);
      onState({ state: 'live', mode: 'direct' });
      backoff = 1000;
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            const ev = safeJson(line.slice(6)) as BridgeEvent | null;
            if (ev && typeof ev.type === 'string') deliver(ev);
          }
        }
      }
      throw new Error('event stream closed');
    };

    const runProxy = async (): Promise<void> => {
      onState({ state: 'live', mode: 'proxy' });
      while (!stopped) {
        const r = await this.#call<{ events: BridgeEvent[]; gap: boolean; epoch: string }>('GET', path(25), undefined, 35_000);
        backoff = 1000;
        if (r.gap) deliver({ seq: 0, epoch: r.epoch, type: 'log.gap', ts: Date.now(), data: {} });
        for (const ev of r.events) deliver(ev);
      }
    };

    const loop = async (): Promise<void> => {
      onState({ state: 'connecting', mode: this.mode });
      while (!stopped) {
        try {
          if (this.mode === 'direct') await runDirect();
          else await runProxy();
        } catch (err) {
          if (stopped) return;
          if (this.mode === 'direct' && err instanceof TypeError && this.#proxy) {
            this.mode = 'proxy';
            continue;
          }
          onState({ state: 'retrying', mode: this.mode, error: (err as Error).message });
          await new Promise((r) => setTimeout(r, backoff));
          backoff = Math.min(backoff * 2, 10_000);
        }
      }
    };
    void loop();
    return () => {
      stopped = true;
      ac?.abort();
    };
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

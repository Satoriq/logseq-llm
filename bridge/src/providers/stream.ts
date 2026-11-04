import type { ToolDef } from '../tools/registry.ts';
import type { Effort } from './types.ts';

/** What the three API formats share: a conversation, one model step at a time, over SSE. */

export type WireCall = { id: string; name: string; args: unknown };

export type WireStep = {
  calls: WireCall[];
  stop: 'end' | 'length' | 'refusal';
  notice?: string;
  inputTokens: number;
  outputTokens: number;
};

export type WireResult = { id: string; name: string; text: string; isError: boolean };

export type WireHandlers = { text: (t: string) => void; thinking: (t: string) => void };

export type WireOptions = {
  label: string;
  url: string;
  key: string;
  model: string;
  effort: Effort;
  system: string;
  /** Earlier turns as text, then the new message. */
  messages: { role: 'user' | 'assistant'; text: string }[];
  tools: ToolDef[];
  signal: AbortSignal;
  /** Added to every request body, for what one provider needs. */
  extraBody?: Record<string, unknown>;
  /** Tool results carry the tool's name too. */
  namedResults?: boolean;
  /** Sends the effort level. Some providers don't take it. */
  sendEffort?: boolean;
};

export type WireSession = {
  step: (on: WireHandlers) => Promise<WireStep>;
  addResults: (results: WireResult[]) => void;
};

export type Wire = (o: WireOptions) => WireSession;

const RETRIES = 2;
const MAX_RETRY_WAIT_MS = 20_000;

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
  });
}

/** The provider's own words, if it sent any. Never includes the request, so never the key. */
async function errorText(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  try {
    const parsed = JSON.parse(body) as unknown;
    // Gemini's compatible endpoint wraps its error in a list.
    const j = (Array.isArray(parsed) ? parsed[0] : parsed) as { error?: { message?: unknown } | string; message?: unknown };
    const m = typeof j.error === 'string' ? j.error : (j.error?.message ?? j.message);
    if (typeof m === 'string' && m !== '') return m.slice(0, 300);
  } catch {
    // Not JSON: the status has to do.
  }
  return `status ${res.status}`;
}

/** POSTs and returns the open stream. Rate limits, overloads and lost connections are retried; nothing else is. */
export async function openStream(o: WireOptions, headers: Record<string, string>, body: unknown): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(o.url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: o.signal });
    } catch (err) {
      if (o.signal.aborted) throw err;
      if (attempt >= RETRIES) throw new Error(`Could not reach ${o.label}.`);
      await wait(1000 * 2 ** attempt, o.signal);
      continue;
    }
    if (res.ok) return res;
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < RETRIES) {
      const after = Number(res.headers.get('retry-after'));
      await res.body?.cancel();
      await wait(Math.min(after > 0 ? after * 1000 : 1000 * 2 ** attempt, MAX_RETRY_WAIT_MS), o.signal);
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new ApiError(res.status, `${o.label} refused the API key. Check it, then add it again (see: node bin/logseq-ai-bridge.ts keys).`);
    throw new ApiError(res.status, `${o.label}: ${await errorText(res)}`);
  }
}

/** The JSON of each `data:` line. All three formats put one event on one line. */
export async function* sseEvents(res: Response): AsyncGenerator<any> {
  if (!res.body) return;
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk as Uint8Array, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, i).trimEnd();
      buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      if (data !== '') yield JSON.parse(data);
    }
  }
}

/** A tool call's arguments. Text that isn't JSON stays text, and ToolRunner tells the model so. */
export function parseArgs(text: string): unknown {
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

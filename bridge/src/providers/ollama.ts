import { request } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { createInterface } from 'node:readline';
import { messageText } from '../chats/store.ts';
import type { ToolCaller, ToolRunner } from '../tools/runner.ts';
import { todayLine } from './claude-cli.ts';
import { isEffort } from './types.ts';
import type { Effort, ModelInfo, Provider, TurnInfo, TurnRequest, TurnResult } from './types.ts';

/**
 * A local model through Ollama on this Mac, reached over 127.0.0.1 only. Nothing leaves the
 * machine, so it gets the local view of the notes (#private and local-only included). Ollama
 * keeps no chat, so the bridge sends the transcript and runs the tool loop itself, through the
 * same ToolRunner as every other model: same privacy filter, cards and audit log.
 */

const KEEP_ALIVE = '5m';
const MODELS_TTL_MS = 30_000;
const MAX_STEPS = 12;
const REPLY_RESERVE_TOKENS = 4096;
/** Rough, and on the safe side: Ukrainian takes more tokens per character than English. */
const CHARS_PER_TOKEN = 3;
const DROPPED = '[This result was dropped to fit the context. Read it again if you still need it.]';
const NOT_RUNNING = "Ollama isn't running. Open the Ollama app and try again.";

export type OllamaOptions = {
  /** http://127.0.0.1:<port>, checked by the config. */
  url: string;
  /** Sent as num_ctx on every request: Ollama's own default is far too small for the tools. */
  contextTokens: number;
  runner: ToolRunner;
  systemPrompt: (turn: TurnInfo) => Promise<string>;
  renderContext: (uuids: string[], turn: TurnInfo) => Promise<string>;
};

type ToolCall = { function: { name: string; arguments: unknown } };

export type OllamaMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  thinking?: string;
  tool_calls?: ToolCall[];
  tool_name?: string;
};

type Chunk = {
  message?: { content?: string; thinking?: string; tool_calls?: ToolCall[] };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
};

type Show = { capabilities?: string[]; thinking?: { values?: unknown[] } };

/** gemma4:cloud, gemma4:31b-cloud: these run on Ollama's servers, so they're never offered. */
export function isCloudModel(name: string): boolean {
  return /[:-]cloud$/i.test(name);
}

/** The picker's levels for a model, and the named levels it accepts as `think`. */
export function effortsFor(show: Show): { efforts: Effort[]; levels: string[] } {
  if (!show.capabilities?.includes('thinking')) return { efforts: ['auto'], levels: [] };
  const values = show.thinking?.values ?? [true, false];
  const levels = values.filter((v): v is Effort => isEffort(v) && v !== 'auto' && v !== 'off');
  const efforts: Effort[] = ['auto'];
  if (values.includes(false)) efforts.push('off');
  efforts.push(...levels);
  // A model that thinks or doesn't: "high" just means on.
  if (levels.length === 0 && values.includes(true)) efforts.push('high');
  return { efforts, levels };
}

function thinkFor(effort: Effort, levels: string[]): boolean | string | undefined {
  if (effort === 'auto') return undefined;
  if (effort === 'off') return false;
  return levels.includes(effort) ? effort : true;
}

/**
 * Keeps a request inside the context, because Ollama would cut the start of the prompt without
 * saying so. Older chat goes first, then this turn's oldest tool results. `turnStart` is the
 * index of the current user message; the system prompt and everything from there stay.
 */
export function fitContext(messages: OllamaMessage[], turnStart: number, budgetChars: number): number {
  const size = (): number => messages.reduce((n, m) => n + m.content.length + (m.thinking?.length ?? 0), 0);
  let start = turnStart;
  while (size() > budgetChars && start > 1) {
    messages.splice(1, 1);
    start -= 1;
  }
  const results = messages.filter((m) => m.role === 'tool' && m.content !== DROPPED).slice(0, -1);
  for (const m of results) {
    if (size() <= budgetChars) break;
    m.content = DROPPED;
  }
  return start;
}

function send(url: string, method: string, path: string, body: unknown, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const text = body === undefined ? undefined : JSON.stringify(body);
    // node:http rather than fetch: fetch gives up after 5 minutes without headers, and a long prompt on a laptop can take a while.
    const req = request(new URL(path, url), { method, signal, headers: text ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) } : {} }, resolve);
    req.on('error', reject);
    req.end(text);
  });
}

async function readAll(res: IncomingMessage): Promise<string> {
  let out = '';
  for await (const c of res) out += String(c);
  return out;
}

async function getJson<T>(url: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await send(url, method, path, body, AbortSignal.timeout(5000));
  const text = await readAll(res);
  if (res.statusCode !== 200) throw new Error(`Ollama answered ${res.statusCode}`);
  return JSON.parse(text) as T;
}

export class OllamaProvider implements Provider {
  readonly id = 'ollama';
  readonly label = 'Ollama';
  readonly locality = 'local' as const;
  #o: OllamaOptions;
  #models: { at: number; list: ModelInfo[] } | null = null;
  #levels = new Map<string, string[]>();

  constructor(opts: OllamaOptions) {
    this.#o = opts;
  }

  /** Local models that can use tools. Empty when Ollama isn't running, so the panel doesn't offer it. */
  async models(): Promise<ModelInfo[]> {
    if (this.#models && Date.now() - this.#models.at < MODELS_TTL_MS) return this.#models.list;
    const list: ModelInfo[] = [];
    try {
      const tags = await getJson<{ models?: { name: string; remote_host?: string }[] }>(this.#o.url, 'GET', '/api/tags');
      for (const m of tags.models ?? []) {
        if (isCloudModel(m.name) || m.remote_host) continue;
        const show = await getJson<Show>(this.#o.url, 'POST', '/api/show', { model: m.name });
        if (!show.capabilities?.includes('tools')) continue;
        const { efforts, levels } = effortsFor(show);
        this.#levels.set(m.name, levels);
        list.push({ id: m.name, label: m.name, efforts });
      }
    } catch {
      return [];
    }
    this.#models = { at: Date.now(), list };
    return list;
  }

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    const o = this.#o;
    if (isCloudModel(req.model)) return { stopReason: 'error', error: 'Cloud models are refused: they would send your notes off this Mac.' };
    const tools = await o.runner.toolsFor(this.locality);
    const turn = { chatId: req.chatId, turnId: req.turnId, locality: this.locality };
    const last = req.messages.at(-1);
    const uuids = last?.meta?.contextUuids ?? [];
    const context = uuids.length > 0 ? await o.renderContext(uuids, turn) : '';
    const prompt =
      `${todayLine(new Date(), false)}\n\n` +
      (context ? `The user has this open in Logseq:\n<context>\n${context}\n</context>\n\n` : '') +
      (last ? messageText(last) : '');

    const messages: OllamaMessage[] = [
      { role: 'system', content: await o.systemPrompt(turn) },
      ...req.messages.slice(0, -1).map((m) => ({ role: m.role, content: messageText(m) })),
      { role: 'user', content: prompt },
    ];
    let turnStart = messages.length - 1;
    const schemas = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
    const budget = (o.contextTokens - REPLY_RESERVE_TOKENS) * CHARS_PER_TOKEN - JSON.stringify(schemas).length;
    const think = thinkFor(req.effort, this.#levels.get(req.model) ?? []);
    const usage = { inputTokens: 0, outputTokens: 0 };
    let wrote = false;
    let pendingBreak = false;

    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        turnStart = fitContext(messages, turnStart, budget);
        const body = {
          model: req.model,
          messages,
          tools: schemas,
          stream: true,
          keep_alive: KEEP_ALIVE,
          options: { num_ctx: o.contextTokens },
          ...(think === undefined ? {} : { think }),
        };
        const res = await send(o.url, 'POST', '/api/chat', body, req.signal);
        if (res.statusCode !== 200) throw new Error(ollamaError(await readAll(res), res.statusCode));

        const answer: OllamaMessage = { role: 'assistant', content: '' };
        const calls: ToolCall[] = [];
        let thinking = '';
        for await (const line of createInterface({ input: res, crlfDelay: Infinity })) {
          if (line.trim() === '') continue;
          const c = JSON.parse(line) as Chunk;
          if (c.error) throw new Error(c.error);
          if (c.message?.thinking) {
            thinking += c.message.thinking;
            req.emit({ type: 'thinking.delta', text: c.message.thinking });
          }
          if (c.message?.content) {
            // Text before and after a tool call stays apart in the reply.
            if (pendingBreak) req.emit({ type: 'text.delta', text: '\n\n' });
            pendingBreak = false;
            wrote = true;
            answer.content += c.message.content;
            req.emit({ type: 'text.delta', text: c.message.content });
          }
          if (c.message?.tool_calls) calls.push(...c.message.tool_calls);
          if (c.done) {
            usage.inputTokens += c.prompt_eval_count ?? 0;
            usage.outputTokens += c.eval_count ?? 0;
            if (c.done_reason === 'length') req.emit({ type: 'notice', message: 'The reply reached the context limit and was cut off.' });
          }
        }
        if (calls.length === 0) return { stopReason: 'end', usage };

        // Thinking goes back with the tool calls: models need it to carry on from them.
        if (thinking) answer.thinking = thinking;
        answer.tool_calls = calls;
        messages.push(answer);
        pendingBreak = wrote;
        for (const call of calls) {
          const name = call.function?.name ?? '';
          const content = await this.#runTool(name, call.function?.arguments, { ...turn, signal: req.signal }, budget);
          messages.push({ role: 'tool', tool_name: name, content });
        }
      }
      req.emit({ type: 'notice', message: `The model made ${MAX_STEPS} rounds of tool calls without finishing, so it was stopped.` });
      return { stopReason: 'end', usage };
    } catch (err) {
      if (req.signal.aborted) return { stopReason: 'cancelled', usage };
      const code = (err as NodeJS.ErrnoException).code;
      return { stopReason: 'error', usage, error: code === 'ECONNREFUSED' ? NOT_RUNNING : (err as Error).message };
    }
  }

  async #runTool(name: string, raw: unknown, turn: ToolCaller, budgetChars: number): Promise<string> {
    const r = await this.#o.runner.call(name, raw, turn);
    const text = r.isError ? `Error: ${r.text}` : r.text;
    const max = Math.floor(budgetChars / 2);
    return text.length > max ? `${text.slice(0, max)}\n[output truncated]` : text;
  }
}

function ollamaError(body: string, status: number | undefined): string {
  try {
    const e = (JSON.parse(body) as { error?: unknown }).error;
    if (typeof e === 'string' && e !== '') return e;
  } catch {
    // Not JSON: the status has to do.
  }
  return `Ollama answered ${status ?? 'with an error'}`;
}

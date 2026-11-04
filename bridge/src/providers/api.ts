import { messageText } from '../chats/store.ts';
import type { Secrets } from '../keychain.ts';
import type { ToolRunner } from '../tools/runner.ts';
import { todayLine } from './claude-cli.ts';
import type { Wire } from './stream.ts';
import type { Effort, ModelInfo, Provider, TurnInfo, TurnRequest, TurnResult } from './types.ts';
import { anthropicWire } from './wire-anthropic.ts';
import { chatWire } from './wire-chat.ts';
import { responsesWire } from './wire-responses.ts';

/**
 * Cloud models through their own APIs, with a key from the Keychain. What's sent is the cloud
 * view, like `claude -p`: the filtered transcript, filtered context and memory, and the same
 * tools through ToolRunner. A provider is only offered once it has a key.
 *
 * Addresses are fixed here on purpose: config can't point a key at another host.
 */

const MAX_STEPS = 20;
/** Every turn resends the chat, and each token costs money. */
const MAX_HISTORY = 40;
const KEY_TTL_MS = 30_000;

const CLAUDE_EFFORTS: Effort[] = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];
const GPT_EFFORTS: Effort[] = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];
const AUTO: Effort[] = ['auto'];

export type ApiPreset = {
  id: string;
  label: string;
  /** The Keychain entry. */
  key: string;
  /** Where to get a key. */
  keysPage: string;
  url: string;
  wire: Wire;
  /** The first is the default. Config's apiModels can add more. */
  models: ModelInfo[];
  sendEffort?: boolean;
  extraBody?: Record<string, unknown>;
  namedResults?: boolean;
};

export const API_PRESETS: ApiPreset[] = [
  {
    id: 'anthropic',
    label: 'Claude API',
    key: 'anthropic',
    keysPage: 'https://platform.claude.com/settings/keys',
    url: 'https://api.anthropic.com/v1/messages',
    wire: anthropicWire,
    models: [
      { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', efforts: CLAUDE_EFFORTS },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', efforts: ['auto', 'off', 'low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', efforts: ['auto', 'off', 'low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'claude-fable-5-1', label: 'Claude Fable 5.1', efforts: CLAUDE_EFFORTS },
    ],
  },
  {
    id: 'openai',
    label: 'OpenAI API',
    key: 'openai',
    keysPage: 'https://platform.openai.com/api-keys',
    url: 'https://api.openai.com/v1/responses',
    wire: responsesWire,
    sendEffort: true,
    models: [
      { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', efforts: GPT_EFFORTS },
      { id: 'gpt-6-astra', label: 'GPT-6 Astra', efforts: GPT_EFFORTS },
      { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra', efforts: ['auto', 'off', 'low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'gpt-6-luna', label: 'GPT-6 Luna', efforts: ['auto', 'off', 'low', 'medium', 'high', 'xhigh', 'max'] },
    ],
  },
  {
    id: 'gemini',
    label: 'Google Gemini',
    key: 'gemini',
    keysPage: 'https://aistudio.google.com/apikey',
    url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    wire: chatWire,
    sendEffort: true,
    models: [
      { id: 'gemini-4-argon', label: 'Gemini 4 Argon', efforts: ['auto', 'low', 'medium', 'high'] },
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', efforts: ['auto', 'low', 'medium', 'high'] },
      { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', efforts: ['auto', 'low', 'medium', 'high'] },
    ],
  },
  {
    id: 'xai',
    label: 'xAI Grok',
    key: 'xai',
    keysPage: 'https://console.x.ai',
    url: 'https://api.x.ai/v1/responses',
    wire: responsesWire,
    models: [
      { id: 'grok-4.7', label: 'Grok 4.7', efforts: AUTO },
      { id: 'grok-4.6', label: 'Grok 4.6', efforts: AUTO },
    ],
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    key: 'deepseek',
    keysPage: 'https://platform.deepseek.com/api_keys',
    url: 'https://api.deepseek.com/chat/completions',
    wire: chatWire,
    // With tools, its thinking mode needs all earlier reasoning sent back, and chats keep only text.
    extraBody: { thinking: { type: 'disabled' } },
    models: [
      { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', efforts: AUTO },
      { id: 'deepseek-flash', label: 'DeepSeek Flash', efforts: AUTO },
    ],
  },
  {
    id: 'mistral',
    label: 'Mistral',
    key: 'mistral',
    keysPage: 'https://console.mistral.ai/api-keys',
    url: 'https://api.mistral.ai/v1/chat/completions',
    wire: chatWire,
    namedResults: true,
    models: [
      { id: 'mistral-large-latest', label: 'Mistral Large', efforts: AUTO },
      { id: 'mistral-medium-latest', label: 'Mistral Medium', efforts: AUTO },
      { id: 'mistral-small-latest', label: 'Mistral Small', efforts: AUTO },
    ],
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    key: 'openrouter',
    keysPage: 'https://openrouter.ai/settings/keys',
    url: 'https://openrouter.ai/api/v1/chat/completions',
    wire: chatWire,
    models: [{ id: 'openrouter/auto', label: 'Auto', efforts: AUTO }],
  },
];

export type ApiProviderOptions = {
  preset: ApiPreset;
  secrets: Secrets;
  runner: ToolRunner;
  systemPrompt: (turn: TurnInfo) => Promise<string>;
  renderContext: (uuids: string[], turn: TurnInfo) => Promise<string>;
  /** Model ids from config's apiModels, for models newer than this list. */
  extraModels?: string[];
};

export class ApiProvider implements Provider {
  readonly id: string;
  readonly label: string;
  readonly locality = 'cloud' as const;
  #o: ApiProviderOptions;
  #hasKey: { at: number; value: boolean } | null = null;

  constructor(opts: ApiProviderOptions) {
    this.#o = opts;
    this.id = opts.preset.id;
    this.label = opts.preset.label;
  }

  async models(): Promise<ModelInfo[]> {
    const { preset, secrets, extraModels } = this.#o;
    if (!this.#hasKey || Date.now() - this.#hasKey.at > KEY_TTL_MS) this.#hasKey = { at: Date.now(), value: await secrets.has(preset.key) };
    if (!this.#hasKey.value) return [];
    const known = new Set(preset.models.map((m) => m.id));
    return [...preset.models, ...(extraModels ?? []).filter((id) => !known.has(id)).map((id) => ({ id, label: id, efforts: AUTO }))];
  }

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    const o = this.#o;
    const { preset } = o;
    const usage = { inputTokens: 0, outputTokens: 0 };
    const turn = { chatId: req.chatId, turnId: req.turnId, locality: this.locality };
    try {
      const key = await o.secrets.get(preset.key);
      if (!key) return { stopReason: 'error', error: `No API key for ${preset.label}. See: node bin/logseq-ai-bridge.ts keys` };
      const last = req.messages.at(-1);
      const uuids = last?.meta?.contextUuids ?? [];
      const context = uuids.length > 0 ? await o.renderContext(uuids, turn) : '';
      const prompt =
        `${todayLine(new Date(), false)}\n\n` +
        (context ? `The user has this open in Logseq (filtered by their privacy settings):\n<context>\n${context}\n</context>\n\n` : '') +
        (last ? messageText(last) : '');
      const session = preset.wire({
        label: preset.label,
        url: preset.url,
        key,
        model: req.model,
        effort: req.effort,
        system: await o.systemPrompt(turn),
        messages: [...req.messages.slice(0, -1).slice(-MAX_HISTORY).map((m) => ({ role: m.role, text: messageText(m) })), { role: 'user', text: prompt }],
        tools: o.runner.tools,
        signal: req.signal,
        ...(preset.extraBody ? { extraBody: preset.extraBody } : {}),
        ...(preset.namedResults ? { namedResults: true } : {}),
        ...(preset.sendEffort ? { sendEffort: true } : {}),
      });

      let wrote = false;
      let pendingBreak = false;
      for (let round = 0; round < MAX_STEPS; round++) {
        const step = await session.step({
          text: (t) => {
            if (t === '') return;
            // Text before and after a tool call stays apart in the reply.
            if (pendingBreak) req.emit({ type: 'text.delta', text: '\n\n' });
            pendingBreak = false;
            wrote = true;
            req.emit({ type: 'text.delta', text: t });
          },
          thinking: (t) => req.emit({ type: 'thinking.delta', text: t }),
        });
        usage.inputTokens += step.inputTokens;
        usage.outputTokens += step.outputTokens;
        if (step.notice) req.emit({ type: 'notice', message: step.notice });
        if (step.stop === 'length') req.emit({ type: 'notice', message: 'The reply reached the length limit and was cut off.' });
        if (step.calls.length === 0) return { stopReason: 'end', usage };

        pendingBreak = wrote;
        const results = [];
        for (const call of step.calls) {
          const r = await o.runner.call(call.name, call.args, turn);
          results.push({ id: call.id, name: call.name, text: r.text, isError: r.isError });
        }
        session.addResults(results);
      }
      req.emit({ type: 'notice', message: `The model made ${MAX_STEPS} rounds of tool calls without finishing, so it was stopped.` });
      return { stopReason: 'end', usage };
    } catch (err) {
      if (req.signal.aborted) return { stopReason: 'cancelled', usage };
      return { stopReason: 'error', usage, error: (err as Error).message };
    }
  }
}

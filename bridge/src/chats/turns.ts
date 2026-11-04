import { randomUUID } from 'node:crypto';
import type { AuditLog } from '../audit.ts';
import { EventLog } from '../events.ts';
import { log } from '../log.ts';
import type { Effort, Provider, ProviderEvent } from '../providers/types.ts';
import type { ChatStore } from './store.ts';

export type StartTurnInput = {
  text: string;
  providerId: string;
  model?: string;
  effort: Effort;
  /** UUIDs of the current page / selected blocks. Only ids: the bridge reads content itself. */
  contextUuids: string[];
  /** Web search on for this message. Refused for providers that can't search. */
  web?: boolean;
};

export class TurnError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type ActiveTurn = { turnId: string; controller: AbortController };

/**
 * Runs one turn at a time per chat: stores the user message, calls the provider,
 * streams its output into the chat's event log and stores the assistant reply.
 */
export class TurnRunner {
  readonly epoch: string;
  #store: ChatStore;
  #providers: Map<string, Provider>;
  #audit: AuditLog;
  #logs = new Map<string, EventLog>();
  #active = new Map<string, ActiveTurn>();
  #onSettled: ((chatId: string) => void) | undefined;

  constructor(opts: { store: ChatStore; providers: Provider[]; audit: AuditLog; epoch: string; onSettled?: (chatId: string) => void }) {
    this.#store = opts.store;
    this.#providers = new Map(opts.providers.map((p) => [p.id, p]));
    this.#audit = opts.audit;
    this.epoch = opts.epoch;
    this.#onSettled = opts.onSettled;
  }

  /** Called when a turn is cancelled or ends (e.g. to reject approvals still waiting). */
  set onSettled(fn: ((chatId: string) => void) | undefined) {
    this.#onSettled = fn;
  }

  providers(): Provider[] {
    return [...this.#providers.values()];
  }

  eventLog(chatId: string): EventLog {
    let l = this.#logs.get(chatId);
    if (!l) {
      l = new EventLog(this.epoch);
      this.#logs.set(chatId, l);
    }
    return l;
  }

  isBusy(chatId: string): boolean {
    return this.#active.has(chatId);
  }

  async start(chatId: string, input: StartTurnInput): Promise<{ turnId: string; done: Promise<void> }> {
    const chat = await this.#store.get(chatId);
    if (!chat) throw new TurnError(404, 'chat not found');
    if (this.#active.has(chatId)) throw new TurnError(409, 'a turn is already running in this chat');
    const provider = this.#providers.get(input.providerId);
    if (!provider) throw new TurnError(400, `unknown provider "${input.providerId}"`);
    const models = await provider.models();
    const model = models.find((m) => m.id === (input.model ?? models[0]?.id));
    if (!model) throw new TurnError(400, `unknown model "${input.model ?? ''}" for provider "${provider.id}"`);
    const web = input.web === true;
    if (web && !provider.webSearch) throw new TurnError(400, `web search isn't available for ${provider.label}`);
    if (!model.efforts.includes(input.effort)) {
      throw new TurnError(400, `effort "${input.effort}" is not supported by ${model.id}`);
    }

    const turnId = randomUUID();
    const controller = new AbortController();
    this.#active.set(chatId, { turnId, controller });
    const events = this.eventLog(chatId);

    try {
      await this.#store.append(chatId, {
        role: 'user',
        parts: [{ type: 'text', text: input.text }],
        meta: { turnId, contextUuids: input.contextUuids, ...(web ? { web: true } : {}) },
      });
      await this.#store.update(chatId, { provider: provider.id, model: model.id, effort: input.effort });
    } catch (err) {
      this.#active.delete(chatId);
      throw err;
    }

    events.append('turn.start', { provider: provider.id, model: model.id, effort: input.effort, locality: provider.locality, web }, turnId);
    await this.#audit.record({
      kind: 'turn.start',
      chatId,
      turnId,
      provider: provider.id,
      model: model.id,
      effort: input.effort,
      locality: provider.locality,
      sentUuids: [],
      ...(web ? { web: true } : {}),
    });

    const done = this.#run(chatId, turnId, provider, model.id, input.effort, web, controller, events);
    return { turnId, done };
  }

  cancel(chatId: string): boolean {
    const active = this.#active.get(chatId);
    if (!active) return false;
    active.controller.abort();
    this.#onSettled?.(chatId);
    return true;
  }

  cancelAll(): void {
    for (const a of this.#active.values()) a.controller.abort();
  }

  async #run(
    chatId: string,
    turnId: string,
    provider: Provider,
    modelId: string,
    effort: Effort,
    web: boolean,
    controller: AbortController,
    events: EventLog,
  ): Promise<void> {
    let text = '';
    let stopReason = 'error';
    let usage: Record<string, number> | undefined;
    try {
      const messages = await this.#store.messages(chatId);
      const emit = (ev: ProviderEvent): void => {
        if (controller.signal.aborted) return;
        if (ev.type === 'text.delta') text += ev.text;
        // Web searches are logged as having happened, never with the query.
        if (ev.type === 'tool.start' && ev.name === 'web_search') void this.#audit.record({ kind: 'tool', chatId, turnId, tool: 'web_search', locality: provider.locality });
        const { type, ...data } = ev;
        events.append(type, data as Record<string, unknown>, turnId);
      };
      const result = await provider.runTurn({ chatId, turnId, messages, model: modelId, effort, web, signal: controller.signal, emit });
      stopReason = controller.signal.aborted ? 'cancelled' : result.stopReason;
      usage = result.usage;
      if (result.stopReason === 'error') {
        events.append('error', { message: result.error ?? 'provider error' }, turnId);
      }
    } catch (err) {
      stopReason = controller.signal.aborted ? 'cancelled' : 'error';
      if (stopReason === 'error') {
        log.error('turn failed', { chatId, turnId, provider: provider.id, error: (err as Error).message });
        events.append('error', { message: (err as Error).message }, turnId);
      }
    } finally {
      try {
        if (text !== '') {
          await this.#store.append(chatId, {
            role: 'assistant',
            parts: [{ type: 'text', text }],
            meta: { turnId, provider: provider.id, model: modelId, effort, locality: provider.locality, stopReason },
          });
        }
      } catch (err) {
        log.error('could not store assistant message', { chatId, turnId, error: (err as Error).message });
      }
      this.#active.delete(chatId);
      this.#onSettled?.(chatId);
      events.append('turn.end', { stopReason, ...(usage ? { usage } : {}) }, turnId);
      await this.#audit.record({ kind: 'turn.end', chatId, turnId, provider: provider.id, model: modelId, outcome: stopReason });
    }
  }
}

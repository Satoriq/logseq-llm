import type { Locality, StoredMessage } from '../chats/store.ts';

/** Picker levels. Each model lists the ones it supports (see docs/PLAN.md §2, Q3). */
export const EFFORTS = ['auto', 'off', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

export function isEffort(v: unknown): v is Effort {
  return typeof v === 'string' && (EFFORTS as readonly string[]).includes(v);
}

export type ModelInfo = {
  id: string;
  label: string;
  efforts: Effort[];
};

/** What a provider can report while a turn runs. The router turns these into chat events. */
export type ProviderEvent =
  | { type: 'text.delta'; text: string }
  | { type: 'thinking.delta'; text: string }
  | { type: 'tool.start'; callId: string; name: string; label: string }
  | { type: 'tool.end'; callId: string; ok: boolean; summary: string; hiddenCount?: number }
  | { type: 'notice'; message: string };

export type TurnRequest = {
  chatId: string;
  turnId: string;
  /** Full transcript including the new user message (already filtered for this provider's locality). */
  messages: StoredMessage[];
  model: string;
  effort: Effort;
  /** The user turned web search on for this message (only for providers with webSearch). */
  web: boolean;
  signal: AbortSignal;
  emit: (ev: ProviderEvent) => void;
};

/** Who a prompt or a context block is being put together for. */
export type TurnInfo = { chatId: string; turnId: string; locality: Locality };

export type TurnResult = {
  stopReason: 'end' | 'cancelled' | 'error';
  usage?: Record<string, number>;
  error?: string;
};

export type ConsultRequest = { model: string; question: string; signal?: AbortSignal };

/** The whole of what a consulted model is told about the situation. */
export const CONSULT_PROMPT =
  "Another AI assistant, running on the user's own computer, is asking you for help. " +
  'Answer the question directly and briefly. You have no tools and no other context.';

export interface Provider {
  readonly id: string;
  readonly label: string;
  /** 'cloud' means content leaves the Mac. Drives the privacy filter and consent cards. */
  readonly locality: Locality;
  /** Can search the web when the user asks for it (per message). */
  readonly webSearch?: boolean;
  models(): Promise<ModelInfo[]>;
  runTurn(req: TurnRequest): Promise<TurnResult>;
  /** You agreed to share a chat's earlier text with this provider. */
  onShared?(chatId: string): Promise<void>;
  /** One question and one answer: no chat, no notes, no tools. */
  consult?(req: ConsultRequest): Promise<string>;
}

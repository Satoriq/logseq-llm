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
  signal: AbortSignal;
  emit: (ev: ProviderEvent) => void;
};

export type TurnResult = {
  stopReason: 'end' | 'cancelled' | 'error';
  usage?: Record<string, number>;
  error?: string;
};

export interface Provider {
  readonly id: string;
  readonly label: string;
  /** 'cloud' means content leaves the Mac. Drives the privacy filter and consent cards. */
  readonly locality: Locality;
  models(): Promise<ModelInfo[]>;
  runTurn(req: TurnRequest): Promise<TurnResult>;
}

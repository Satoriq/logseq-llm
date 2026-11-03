/** Shapes shared with the bridge's HTTP API (see bridge/src/http/server.ts). */

export type Effort = 'auto' | 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type Locality = 'local' | 'cloud';

export type ModelInfo = { id: string; label: string; efforts: Effort[] };
export type ProviderInfo = { id: string; label: string; locality: Locality; models: ModelInfo[] };

export type ChatMeta = { id: string; title: string; createdAt: number; updatedAt: number; provider?: string; model?: string; effort?: string };

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; content: string; isError?: boolean };

export type StoredMessage = {
  id: string;
  role: 'user' | 'assistant';
  ts: number;
  parts: MessagePart[];
  meta?: { provider?: string; model?: string; effort?: string; locality?: Locality; stopReason?: string; contextUuids?: string[] };
};

export type BridgeEvent = {
  seq: number;
  epoch: string;
  type: string;
  ts: number;
  turnId?: string;
  data: Record<string, unknown>;
};

export type ChatState = { chat: ChatMeta; messages: StoredMessage[]; busy: boolean; lastSeq: number; epoch: string };

/** What the panel needs from Logseq (real implementation in main.ts, a fake in tests). */
export type EditorPort = {
  openPage: (title: string) => void;
  openBlock: (uuid: string) => void;
  openExternal: (url: string) => void;
  /** What the main view shows: a page, or a block you zoomed into. */
  currentPage: () => Promise<{ uuid: string; title: string; kind: 'page' | 'block' } | null>;
};

export type PanelSide = 'right' | 'left' | 'top' | 'bottom';

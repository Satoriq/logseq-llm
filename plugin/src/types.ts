/** Shapes shared with the bridge's HTTP API (see bridge/src/http/server.ts). */

/** The one chat that holds cards from connected apps (same id as in bridge/src/mcp/clients.ts). */
export const APPS_CHAT_ID = '00000000-0000-4000-8000-0000000000a1';

export type Effort = 'auto' | 'off' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type Locality = 'local' | 'cloud';

export type ModelInfo = { id: string; label: string; efforts: Effort[] };
export type ProviderInfo = { id: string; label: string; locality: Locality; models: ModelInfo[]; webSearch?: boolean };

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

export type PreviewBody =
  | { kind: 'blocks'; text: string }
  | { kind: 'diff'; before: string; after: string }
  | { kind: 'diffs'; items: { before: string; after: string }[] }
  | { kind: 'remove'; text: string }
  | { kind: 'text'; text: string };

/** A write waiting for Apply/Reject (see bridge/src/approvals.ts). */
export type ApprovalView = {
  id: string;
  chatId: string;
  turnId: string;
  tool: string;
  title: string;
  target: string;
  body: PreviewBody;
  warnings: string[];
  createdAt: number;
  /** Applied without a click: autoApply, or "Apply all" earlier in this answer. */
  auto?: boolean;
  /** Edits/deletes applied without a click wait this long first, so you can Abort. */
  graceMs?: number;
};

/** Your own instructions for the AI, kept by the bridge. `builtIn` is the fixed part, shown read-only. */
export type InstructionsState = { text: string; updatedAt: number | null; maxChars: number; builtIn: string; memoryPage?: string | null };

export type ChatState = { chat: ChatMeta; messages: StoredMessage[]; busy: boolean; lastSeq: number; epoch: string; approvals?: ApprovalView[] };

/** What the panel needs from Logseq (real implementation in main.ts, a fake in tests). */
export type EditorPort = {
  openPage: (title: string) => void;
  openBlock: (uuid: string) => void;
  openExternal: (url: string) => void;
  /** What the main view shows: a page, or a block you zoomed into. */
  currentPage: () => Promise<{ uuid: string; title: string; kind: 'page' | 'block' } | null>;
};

export type PanelSide = 'right' | 'left' | 'top' | 'bottom';

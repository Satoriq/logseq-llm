import type { ApprovalRequest, ApprovalView, Decision } from '../approvals.ts';
import type { Locality } from '../chats/store.ts';

/** Provider-neutral tool definition. The same set goes to claude (MCP), the APIs and Ollama. */
export type ToolKind = 'read' | 'write' | 'editor';

export type ApproveFn = (req: ApprovalRequest) => Promise<{ view: ApprovalView; decision: Decision }>;

export type ToolContext = {
  /** Who will see the result. 'cloud' hides #private / local-only content. */
  locality: Locality;
  signal?: AbortSignal;
  chatId?: string;
  turnId?: string;
  /** Shows an approval card and waits for Apply/Reject. Write tools refuse to run without it. */
  approve?: ApproveFn;
  /** Reports how an approval ended (shown on the card). */
  resolved?: (view: ApprovalView, outcome: 'applied' | 'rejected' | 'failed', detail: string) => void;
};

export type ToolOutput = {
  /** What the model sees. */
  text: string;
  /** UUIDs whose content is in `text` (for the audit log). */
  sentUuids: string[];
  /** Items the filter removed. Shown to you only, never to the model. */
  hiddenCount: number;
};

export type ToolDef = {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  inputSchema: Record<string, unknown>;
  kind: ToolKind;
  /** Short label for the panel's tool step, e.g. 'searching "apples"'. */
  label: (args: Record<string, unknown>) => string;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutput>;
};

/** Errors a tool returns to the model as a normal tool result (not a crash). */
export class ToolInputError extends Error {}

export function argString(args: Record<string, unknown>, key: string, opts: { required: boolean; max: number }): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === '') {
    if (opts.required) throw new ToolInputError(`"${key}" is required`);
    return undefined;
  }
  if (typeof v !== 'string') throw new ToolInputError(`"${key}" must be a string`);
  if (v.length > opts.max) throw new ToolInputError(`"${key}" is too long (max ${opts.max})`);
  if (v.includes('\0')) throw new ToolInputError(`"${key}" contains a NUL byte`);
  return v;
}

export function argInt(args: Record<string, unknown>, key: string, opts: { min: number; max: number; fallback: number }): number {
  const v = args[key];
  if (v === undefined || v === null) return opts.fallback;
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new ToolInputError(`"${key}" must be an integer`);
  return Math.min(opts.max, Math.max(opts.min, v));
}

export function argBool(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = args[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'boolean') throw new ToolInputError(`"${key}" must be true or false`);
  return v;
}

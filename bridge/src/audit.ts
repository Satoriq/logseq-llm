import { appendFile } from 'node:fs/promises';
import { log } from './log.ts';

/**
 * Append-only audit log (JSON lines, mode 0600). It records what was sent where,
 * by id, never the content itself.
 */
export type AuditEntry = {
  kind: 'turn.start' | 'turn.end' | 'tool' | 'write' | 'consent' | 'settings';
  chatId: string;
  turnId?: string;
  provider?: string;
  model?: string;
  effort?: string;
  locality?: 'local' | 'cloud';
  /** Block/page UUIDs whose content was sent to the model. */
  sentUuids?: string[];
  /** Count of items the privacy filter hid (no ids, so the log itself leaks nothing). */
  hiddenCount?: number;
  tool?: string;
  outcome?: string;
  /** Blocks/pages a write touched (ids only). */
  targetUuids?: string[];
};

export class AuditLog {
  readonly file: string;
  #queue: Promise<void> = Promise.resolve();

  constructor(file: string) {
    this.file = file;
  }

  record(entry: AuditEntry): Promise<void> {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n';
    // Serialize appends so lines never interleave.
    this.#queue = this.#queue
      .then(() => appendFile(this.file, line, { mode: 0o600 }))
      .catch((err: unknown) => {
        log.warn('audit write failed', { error: (err as Error).message });
      });
    return this.#queue;
  }
}

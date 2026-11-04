import { readFile } from 'node:fs/promises';
import type { AutoApplyMode } from './config.ts';
import { writeFileAtomic } from './config.ts';

/**
 * Settings you change in the panel. They live in the bridge because the bridge enforces them,
 * and only the panel's token can reach them, so a model can't approve its own changes.
 *
 * Auto-approve is kept per graph, so ticking a box on a test graph says nothing about another.
 * Once saved for a graph, it replaces config.json's autoApply for that graph.
 */

export type AutoApprove = { writes: boolean; edits: boolean; deletes: boolean };

export class SettingsError extends Error {}

export function cleanAutoApprove(raw: unknown): AutoApprove {
  const v = raw as Partial<AutoApprove> | null;
  if (v === null || typeof v !== 'object' || typeof v.writes !== 'boolean' || typeof v.edits !== 'boolean' || typeof v.deletes !== 'boolean') {
    throw new SettingsError('"autoApprove" needs writes, edits and deletes, each true or false');
  }
  return { writes: v.writes, edits: v.edits, deletes: v.deletes };
}

/** What the boxes show for a graph you never saved them for. */
export function autoApproveFrom(mode: AutoApplyMode): AutoApprove {
  return { writes: mode !== 'none', edits: mode === 'all', deletes: mode === 'all' };
}

export class Settings {
  readonly graph: string | null;
  #file: string;
  #fallback: AutoApprove;

  constructor(opts: { file: string; graph: string | null; fallback: AutoApprove }) {
    this.#file = opts.file;
    this.graph = opts.graph;
    this.#fallback = opts.fallback;
  }

  async #all(): Promise<Record<string, unknown>> {
    try {
      const parsed = JSON.parse(await readFile(this.#file, 'utf8')) as { autoApprove?: unknown };
      return parsed.autoApprove !== null && typeof parsed.autoApprove === 'object' ? (parsed.autoApprove as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  /** What you saved for this graph. Null if you never did, or the file is damaged: nothing here grants more than config.json. */
  async saved(): Promise<AutoApprove | null> {
    if (this.graph === null) return null;
    try {
      const entry = (await this.#all())[this.graph];
      return entry === undefined ? null : cleanAutoApprove(entry);
    } catch {
      return null;
    }
  }

  async autoApprove(): Promise<AutoApprove> {
    return (await this.saved()) ?? this.#fallback;
  }

  async setAutoApprove(raw: unknown): Promise<AutoApprove> {
    if (this.graph === null) throw new SettingsError('No graph is set in config.json.');
    const value = cleanAutoApprove(raw);
    const all = { ...(await this.#all()), [this.graph]: value };
    await writeFileAtomic(this.#file, `${JSON.stringify({ autoApprove: all }, null, 2)}\n`);
    return value;
  }
}

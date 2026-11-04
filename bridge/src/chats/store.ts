import { randomUUID } from 'node:crypto';
import { appendFile, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../config.ts';

/**
 * Provider-neutral transcripts. One `<id>.meta.json` plus one `<id>.jsonl`
 * (one message per line) per chat, all mode 0600 inside the 0700 data dir.
 */

export type Locality = 'local' | 'cloud';

export type MessagePart =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; id: string; name: string; args: unknown }
  | { type: 'tool_result'; id: string; content: string; isError?: boolean };

export type MessageMeta = {
  provider?: string;
  model?: string;
  effort?: string;
  locality?: Locality;
  turnId?: string;
  stopReason?: string;
  /** UUIDs whose content went to the model in this message (filled from step 1b). */
  sentUuids?: string[];
  /** Context the user attached (UUIDs only). */
  contextUuids?: string[];
  /** Web search was on for this message. */
  web?: boolean;
};

export type StoredMessage = {
  id: string;
  role: 'user' | 'assistant';
  ts: number;
  parts: MessagePart[];
  meta?: MessageMeta;
};

/**
 * What a provider may see of a chat. A cloud model gets only what was already said to a cloud
 * model. Replies from local models stay local, and so do your messages to them: they can quote
 * private notes, and no filter can redact what you typed. Anything unlabeled counts as local.
 */
export function transcriptFor(messages: StoredMessage[], locality: Locality): StoredMessage[] {
  return locality === 'local' ? messages : messages.filter((m) => m.meta?.locality === 'cloud');
}

export type ChatMeta = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  provider?: string;
  model?: string;
  effort?: string;
  /** claude -p session id (`--session-id` on the first turn, `--resume` afterwards). */
  claudeSessionId?: string;
  /** UUIDs of blocks/pages the AI created in this chat (for autoApply "own"). */
  aiCreated?: string[];
};

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isChatId(id: string): boolean {
  return ID_RE.test(id);
}

export class ChatStore {
  readonly dir: string;
  #metaCache = new Map<string, ChatMeta>();

  constructor(dir: string) {
    this.dir = dir;
  }

  #metaPath(id: string): string {
    if (!isChatId(id)) throw new Error('invalid chat id');
    return join(this.dir, `${id}.meta.json`);
  }

  #messagesPath(id: string): string {
    if (!isChatId(id)) throw new Error('invalid chat id');
    return join(this.dir, `${id}.jsonl`);
  }

  async create(title?: string, id: string = randomUUID()): Promise<ChatMeta> {
    const now = Date.now();
    const meta: ChatMeta = {
      id,
      title: (title ?? '').trim().slice(0, 200) || 'New chat',
      createdAt: now,
      updatedAt: now,
    };
    await writeFileAtomic(this.#metaPath(meta.id), JSON.stringify(meta, null, 2) + '\n');
    this.#metaCache.set(meta.id, meta);
    return meta;
  }

  /** A chat with a fixed id, created the first time. */
  async ensure(id: string, title: string): Promise<ChatMeta> {
    return (await this.get(id)) ?? this.create(title, id);
  }

  async get(id: string): Promise<ChatMeta | null> {
    if (!isChatId(id)) return null;
    const cached = this.#metaCache.get(id);
    if (cached) return cached;
    try {
      const meta = JSON.parse(await readFile(this.#metaPath(id), 'utf8')) as ChatMeta;
      this.#metaCache.set(id, meta);
      return meta;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  async list(): Promise<ChatMeta[]> {
    const names = await readdir(this.dir);
    const out: ChatMeta[] = [];
    for (const name of names) {
      const m = /^(.+)\.meta\.json$/.exec(name);
      if (!m || !m[1] || !isChatId(m[1])) continue;
      const meta = await this.get(m[1]);
      if (meta) out.push(meta);
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async update(id: string, patch: Partial<Omit<ChatMeta, 'id' | 'createdAt'>>): Promise<ChatMeta> {
    const meta = await this.get(id);
    if (!meta) throw new Error('chat not found');
    const next: ChatMeta = { ...meta, ...patch, id: meta.id, createdAt: meta.createdAt, updatedAt: Date.now() };
    await writeFileAtomic(this.#metaPath(id), JSON.stringify(next, null, 2) + '\n');
    this.#metaCache.set(id, next);
    return next;
  }

  async append(id: string, message: Omit<StoredMessage, 'id' | 'ts'>): Promise<StoredMessage> {
    const stored: StoredMessage = { id: randomUUID(), ts: Date.now(), ...message };
    await appendFile(this.#messagesPath(id), JSON.stringify(stored) + '\n', { mode: 0o600 });
    await this.update(id, {});
    return stored;
  }

  async messages(id: string): Promise<StoredMessage[]> {
    let text: string;
    try {
      text = await readFile(this.#messagesPath(id), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const out: StoredMessage[] = [];
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line) as StoredMessage);
      } catch {
        // Skip a torn last line (e.g. after a crash mid-write).
      }
    }
    return out;
  }
}

/** Concatenates the text parts of a message. */
export function messageText(m: StoredMessage): string {
  return m.parts
    .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

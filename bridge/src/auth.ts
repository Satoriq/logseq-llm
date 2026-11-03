import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from './config.ts';

/**
 * Token scopes.
 * - plugin: the Logseq panel (everything except the MCP endpoint)
 * - voice:  the voice helper (send an utterance, read replies; routes arrive in step 8)
 * Per-process MCP tokens for `claude` are created in memory in step 1c.
 */
export type Scope = 'plugin' | 'voice';

export type Tokens = Record<Scope, string>;

const SCOPES: readonly Scope[] = ['plugin', 'voice'];

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time comparison (hashing first makes the lengths equal). */
export function tokenEquals(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

/** Returns the bearer token from an Authorization header, or null. */
export function bearerFrom(header: string | undefined): string | null {
  if (!header) return null;
  const m = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(header.trim());
  return m ? (m[1] ?? null) : null;
}

/** Finds which scope a presented token belongs to. Checks every scope to keep timing uniform. */
export function scopeForToken(token: string | null, tokens: Tokens): Scope | null {
  if (!token) return null;
  let found: Scope | null = null;
  for (const scope of SCOPES) {
    if (tokenEquals(token, tokens[scope]) && found === null) found = scope;
  }
  return found;
}

function isTokens(v: unknown): v is Tokens {
  if (v === null || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return SCOPES.every((s) => typeof o[s] === 'string' && (o[s] as string).length >= 32);
}

/**
 * Loads the bridge tokens from secrets/tokens.json (mode 0600), creating them on first run.
 * The plugin's copy lives in Logseq's plugin settings, which are plain files too, so the
 * Keychain would add little here; API keys (step 4) do go in the Keychain.
 */
export async function loadOrCreateTokens(file: string): Promise<Tokens> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (isTokens(parsed)) return { plugin: parsed.plugin, voice: parsed.voice };
    throw new Error(`token file is malformed: ${file} (delete it or run rotate-token)`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  return rotateTokens(file);
}

export async function rotateTokens(file: string): Promise<Tokens> {
  const tokens: Tokens = { plugin: newToken(), voice: newToken() };
  await writeFileAtomic(file, JSON.stringify(tokens, null, 2) + '\n');
  return tokens;
}

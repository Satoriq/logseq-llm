import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { parseRule } from './policy/rules.ts';

export const BRIDGE_NAME = 'logseq-ai-bridge';
export const BRIDGE_VERSION = '0.3.0';
export const DEFAULT_PORT = 47615;
export const MIN_NODE_MAJOR = 26;

/** Allow/deny rules, e.g. "tag:private", "page:Diary", "journal:..2025-12-31". See policy/rules.ts. */
export type PolicyConfig = {
  deny: string[];
  allow: string[];
};

export type BridgeConfig = {
  /** Port on 127.0.0.1. The bridge never listens on any other address. */
  port: number;
  /** Exact Origin values allowed to call the bridge (the plugin's origin). */
  allowedOrigins: string[];
  /** Absolute path of the `logseq` CLI. */
  logseqBin: string;
  /** Absolute path of the `claude` CLI. */
  claudeBin: string;
  /** Graph the tools read. null = the CLI's current graph. */
  graph: string | null;
  /** Graphs the bridge may write to (after approval). Empty = none. */
  writeGraphs: string[];
  /**
   * Per graph: which approved-write kinds skip the card.
   *   none       every write needs Apply (default)
   *   additions  new blocks/tasks/pages go in directly, but only when the card would show no warnings
   *   own        additions, plus edits/deletes of blocks the AI itself added in the same chat (no warnings)
   *   all        everything goes in directly (still checked and logged)
   */
  autoApply: Record<string, AutoApplyMode>;
  cliTimeoutMs: number;
  cliConcurrency: number;
  /** Pass --restricted to claude (no user/project settings, no code tools). Default true. */
  claudeRestricted: boolean;
  policy: PolicyConfig;
};

export type AutoApplyMode = 'none' | 'additions' | 'own' | 'all';
const AUTO_MODES: readonly AutoApplyMode[] = ['none', 'additions', 'own', 'all'];

export type DataPaths = {
  root: string;
  config: string;
  secrets: string;
  tokens: string;
  chats: string;
  audit: string;
  logs: string;
  run: string;
  claudeCwd: string;
  doctor: string;
};

export function defaultDataDir(): string {
  const fromEnv = process.env.LOGSEQ_AI_DATA_DIR;
  if (fromEnv && fromEnv.trim() !== '') return fromEnv;
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'logseq-ai');
  }
  return join(homedir(), '.local', 'share', 'logseq-ai');
}

export function dataPaths(root: string): DataPaths {
  const secrets = join(root, 'secrets');
  return {
    root,
    config: join(root, 'config.json'),
    secrets,
    tokens: join(secrets, 'tokens.json'),
    chats: join(root, 'chats'),
    audit: join(root, 'audit.jsonl'),
    logs: join(root, 'logs'),
    run: join(root, 'run'),
    claudeCwd: join(root, 'claude-cwd'),
    doctor: join(root, 'doctor'),
  };
}

export function defaultConfig(): BridgeConfig {
  const home = homedir();
  return {
    port: DEFAULT_PORT,
    // Unpacked plugins load from lsp://logseq.com/external/... (same origin as the app).
    // Confirm in DevTools during step 2 and change here if it differs.
    allowedOrigins: ['lsp://logseq.com'],
    logseqBin: join(home, '.local', 'bin', 'logseq'),
    claudeBin: join(home, '.local', 'bin', 'claude'),
    graph: null,
    writeGraphs: [],
    autoApply: {},
    cliTimeoutMs: 15000,
    cliConcurrency: 2,
    claudeRestricted: true,
    policy: { deny: [], allow: [] },
  };
}

/** Creates the data directory tree with owner-only permissions. */
export async function ensureDataDirs(paths: DataPaths): Promise<void> {
  for (const dir of [paths.root, paths.secrets, paths.chats, paths.logs, paths.run, paths.claudeCwd, paths.doctor]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await chmod(dir, 0o700);
  }
}

function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Validates a parsed config.json and merges it over the defaults.
 * Unknown keys are rejected so typos don't silently weaken a setting.
 */
export function mergeConfig(base: BridgeConfig, raw: unknown): BridgeConfig {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('config.json must contain a JSON object');
  }
  const input = raw as Record<string, unknown>;
  const known = new Set(Object.keys(base));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) throw new Error(`config.json: unknown key "${key}"`);
  }
  const out: BridgeConfig = { ...base, policy: { ...base.policy } };

  if (input.port !== undefined) {
    const port = input.port;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error('config.json: "port" must be an integer between 1024 and 65535');
    }
    out.port = port;
  }
  if (input.allowedOrigins !== undefined) {
    if (!isStringArray(input.allowedOrigins)) throw new Error('config.json: "allowedOrigins" must be an array of strings');
    for (const o of input.allowedOrigins) {
      if (o === 'null' || o === '*' || o.trim() === '') throw new Error(`config.json: origin "${o}" is not allowed`);
    }
    out.allowedOrigins = [...input.allowedOrigins];
  }
  for (const key of ['logseqBin', 'claudeBin'] as const) {
    const v = input[key];
    if (v === undefined) continue;
    if (typeof v !== 'string') throw new Error(`config.json: "${key}" must be a string`);
    const p = expandHome(v);
    if (!isAbsolute(p)) throw new Error(`config.json: "${key}" must be an absolute path`);
    out[key] = p;
  }
  if (input.graph !== undefined) {
    if (input.graph !== null && (typeof input.graph !== 'string' || input.graph.trim() === '')) {
      throw new Error('config.json: "graph" must be a non-empty string or null');
    }
    out.graph = input.graph as string | null;
  }
  if (input.writeGraphs !== undefined) {
    if (!isStringArray(input.writeGraphs)) throw new Error('config.json: "writeGraphs" must be an array of strings');
    out.writeGraphs = [...input.writeGraphs];
  }
  if (input.autoApply !== undefined) {
    const a = input.autoApply;
    if (a === null || typeof a !== 'object' || Array.isArray(a)) throw new Error('config.json: "autoApply" must be an object like {"AI Sandbox": "additions"}');
    const outA: Record<string, AutoApplyMode> = {};
    for (const [graph, mode] of Object.entries(a as Record<string, unknown>)) {
      if (!AUTO_MODES.includes(mode as AutoApplyMode)) throw new Error(`config.json: autoApply["${graph}"] must be "none", "additions", "own" or "all"`);
      outA[graph] = mode as AutoApplyMode;
    }
    out.autoApply = outA;
  }
  for (const key of ['cliTimeoutMs', 'cliConcurrency'] as const) {
    const v = input[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
      throw new Error(`config.json: "${key}" must be a positive integer`);
    }
    out[key] = v;
  }
  if (input.claudeRestricted !== undefined) {
    if (typeof input.claudeRestricted !== 'boolean') throw new Error('config.json: "claudeRestricted" must be true or false');
    out.claudeRestricted = input.claudeRestricted;
  }
  if (input.policy !== undefined) {
    const p = input.policy;
    if (p === null || typeof p !== 'object' || Array.isArray(p)) throw new Error('config.json: "policy" must be an object');
    const pol = p as Record<string, unknown>;
    for (const k of Object.keys(pol)) {
      if (k !== 'deny' && k !== 'allow') throw new Error(`config.json: unknown policy key "${k}"`);
    }
    for (const key of ['deny', 'allow'] as const) {
      const list = pol[key];
      if (list === undefined) continue;
      if (!isStringArray(list)) throw new Error(`config.json: "policy.${key}" must be an array of strings`);
      for (const rule of list) {
        try {
          parseRule(rule);
        } catch (err) {
          // A broken rule must stop the bridge, not be skipped: skipping a deny rule would leak.
          throw new Error(`config.json: policy.${key}: ${(err as Error).message}`);
        }
      }
      out.policy[key] = [...list];
    }
  }
  return out;
}

/** Loads config.json, creating it with defaults (mode 0600) on first run. */
export async function loadConfig(paths: DataPaths): Promise<BridgeConfig> {
  const base = defaultConfig();
  let text: string;
  try {
    text = await readFile(paths.config, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    await writeFileAtomic(paths.config, JSON.stringify(base, null, 2) + '\n');
    return base;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`config.json is not valid JSON (${paths.config})`);
  }
  return mergeConfig(base, raw);
}

/** Writes a file via a temp file + rename, owner read/write only. */
export async function writeFileAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, content, { mode: 0o600 });
  await rename(tmp, path);
}

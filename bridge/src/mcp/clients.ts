import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { newToken } from '../auth.ts';
import { writeFileAtomic } from '../config.ts';

/**
 * Apps that start the bridge's tools as a local MCP program. Each has its own token, so the
 * audit log tells them apart and one can be cut off alone. They always count as cloud: the
 * bridge can't see what such an app does with a result. Their writes go through the same
 * checks as any other, and wait on cards in the Logseq panel (see endpoint.ts).
 *
 * connect and disconnect change that app's own config file (keeping a backup), and only the
 * "logseq-ai" entry in it.
 */

export const MCP_CLIENTS = ['claude-desktop', 'codex'] as const;
export type McpClientName = (typeof MCP_CLIENTS)[number];

/** One chat for all connected apps. It holds their cards, not a conversation, so it isn't listed. */
export const APPS_CHAT_ID = '00000000-0000-4000-8000-0000000000a1';

const SERVER_KEY = 'logseq-ai';
const CODEX_TABLE = `[mcp_servers.${SERVER_KEY}]`;

type ServerEntry = { command: string; args: string[] };

export function isMcpClient(v: unknown): v is McpClientName {
  return typeof v === 'string' && (MCP_CLIENTS as readonly string[]).includes(v);
}

export function clientLabel(client: string): string {
  return client === 'claude-desktop' ? 'Claude Desktop' : client === 'codex' ? 'Codex' : client;
}

export function clientConfigPath(client: McpClientName, home: string): string {
  return client === 'claude-desktop'
    ? join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
    : join(home, '.codex', 'config.toml');
}

/** client → token. A missing or damaged file means no app is connected. */
export async function readClientTokens(file: string): Promise<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'));
    if (parsed === null || typeof parsed !== 'object') return {};
    return Object.fromEntries(Object.entries(parsed).filter(([k, v]) => isMcpClient(k) && typeof v === 'string' && v.length >= 32));
  } catch {
    return {};
  }
}

async function readIfExists(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function withClaudeEntry(text: string | null, entry: ServerEntry | null, file: string): string {
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(text ?? '{}') as Record<string, unknown>;
  } catch {
    throw new Error(`${file} isn't valid JSON, so it was left alone. Fix it and run this again.`);
  }
  const servers = { ...((config.mcpServers ?? {}) as Record<string, unknown>) };
  if (entry) servers[SERVER_KEY] = entry;
  else delete servers[SERVER_KEY];
  if (Object.keys(servers).length > 0) config.mcpServers = servers;
  else delete config.mcpServers;
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Removes our table. Tables end at the next header; the args we write stay on one line. */
function dropCodexTable(text: string): string {
  let skip = false;
  const kept = text.split('\n').filter((line) => {
    if (line.trimStart().startsWith('[')) skip = line.trim() === CODEX_TABLE;
    return !skip;
  });
  return kept.join('\n').trimEnd();
}

function withCodexEntry(text: string | null, entry: ServerEntry | null): string {
  const kept = dropCodexTable(text ?? '');
  if (!entry) return kept === '' ? '' : `${kept}\n`;
  // A JSON string is also a valid TOML basic string.
  const table = `${CODEX_TABLE}\ncommand = ${JSON.stringify(entry.command)}\nargs = [${entry.args.map((a) => JSON.stringify(a)).join(', ')}]\n`;
  return kept === '' ? table : `${kept}\n\n${table}`;
}

async function editAppConfig(client: McpClientName, home: string, entry: ServerEntry | null): Promise<string> {
  const file = clientConfigPath(client, home);
  const before = await readIfExists(file);
  if (before === null && entry === null) return file;
  const after = client === 'claude-desktop' ? withClaudeEntry(before, entry, file) : withCodexEntry(before, entry);
  if (after === before) return file;
  await mkdir(dirname(file), { recursive: true });
  if (before !== null) await copyFile(file, `${file}.logseq-ai.bak`);
  await writeFileAtomic(file, after);
  return file;
}

/** Gives the app a token and adds the entry that starts `<node> <script> mcp <client>`. Returns the file changed. */
export async function connectClient(client: McpClientName, o: { tokensFile: string; home: string; node: string; script: string }): Promise<string> {
  const file = await editAppConfig(client, o.home, { command: o.node, args: [o.script, 'mcp', client] });
  const tokens = await readClientTokens(o.tokensFile);
  tokens[client] ??= newToken();
  await writeFileAtomic(o.tokensFile, `${JSON.stringify(tokens, null, 2)}\n`);
  return file;
}

/** Revokes the token first, so the app is cut off even if its config file can't be changed. Returns the file changed. */
export async function disconnectClient(client: McpClientName, o: { tokensFile: string; home: string }): Promise<string> {
  const tokens = await readClientTokens(o.tokensFile);
  delete tokens[client];
  await writeFileAtomic(o.tokensFile, `${JSON.stringify(tokens, null, 2)}\n`);
  return editAppConfig(client, o.home, null);
}

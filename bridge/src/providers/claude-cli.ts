import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { messageText } from '../chats/store.ts';
import type { ChatStore, StoredMessage } from '../chats/store.ts';
import { log } from '../log.ts';
import { MCP_SERVER_NAME } from '../mcp/endpoint.ts';
import type { McpSessions } from '../mcp/endpoint.ts';
import type { Effort, ModelInfo, Provider, TurnRequest, TurnResult } from './types.ts';

/**
 * Claude through the user's own, unmodified `claude` binary (Pro plan), headless.
 * One process per turn; the conversation continues with --resume <session id>.
 *
 * The process gets no built-in tools, no user/project settings, no other MCP servers
 * and no slash commands. Its only tools are the bridge's filtered graph tools at /mcp,
 * reached with a token that only works for this chat and this turn.
 */

const ALL_EFFORTS: Effort[] = ['auto', 'low', 'medium', 'high', 'xhigh', 'max'];

export const CLAUDE_MODELS: ModelInfo[] = [
  { id: 'sonnet', label: 'Sonnet (latest)', efforts: ALL_EFFORTS },
  { id: 'opus', label: 'Opus (latest)', efforts: ALL_EFFORTS },
  { id: 'haiku', label: 'Haiku (latest)', efforts: ALL_EFFORTS },
  { id: 'fable', label: 'Fable (latest)', efforts: ALL_EFFORTS },
];

export type ClaudeCliOptions = {
  bin: string;
  /** Empty working directory for claude (no project CLAUDE.md, settings or files). */
  cwd: string;
  /** Where the per-turn MCP config files (mode 0600) are written. */
  runDir: string;
  /** Base URL of this bridge, known after listen(). */
  bridgeUrl: () => string;
  sessions: McpSessions;
  toolNames: () => string[];
  store: ChatStore;
  systemPrompt: string;
  /** --restricted (default true). Turn off only if your claude version rejects it. */
  restricted: boolean;
  /** Renders the page/selection the user attached, filtered for cloud. */
  renderContext: (uuids: string[], chatId: string, turnId: string) => Promise<string>;
  turnTimeoutMs: number;
};

/** The exact argv (no shell). Exported for tests and for `docs`. */
export function claudeArgs(o: {
  mcpConfigPath: string;
  allowedTools: string[];
  systemPrompt: string;
  model: string;
  effort: Effort;
  sessionId: string;
  resume: boolean;
  restricted: boolean;
}): string[] {
  const args = [
    '-p',
    '--verbose',
    '--input-format', 'text',
    '--output-format', 'stream-json',
    '--include-partial-messages',
    ...(o.restricted ? ['--restricted'] : []),
    '--tools', '',
    '--strict-mcp-config',
    '--mcp-config', o.mcpConfigPath,
    '--allowedTools', o.allowedTools.join(','),
    '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none',
    '--disable-slash-commands',
    '--system-prompt', o.systemPrompt,
    '--model', o.model,
    ...(o.effort !== 'auto' ? ['--effort', o.effort] : []),
    ...(o.resume ? ['--resume', o.sessionId] : ['--session-id', o.sessionId]),
  ];
  return args;
}

function childEnv(): NodeJS.ProcessEnv {
  // No ANTHROPIC_API_KEY or other secrets: claude must use the Pro login from the Keychain.
  const env: NodeJS.ProcessEnv = { DISABLE_AUTOUPDATER: '1' };
  for (const k of ['HOME', 'PATH', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'TERM']) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

/** Earlier messages to hand over when a chat moves to claude. Local-model replies stay local. */
function handoff(messages: StoredMessage[]): string {
  const prior = messages.slice(0, -1).filter((m) => m.role === 'user' || m.meta?.locality === 'cloud').slice(-20);
  if (prior.length === 0) return '';
  const lines = prior.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${messageText(m).slice(0, 4000)}`);
  return `Conversation so far (earlier turns; replies from local models are not included):\n${lines.join('\n\n')}\n\n`;
}

type ClaudeEvent = Record<string, unknown> & { type?: string; subtype?: string };

/** "Today is Tuesday 2026-11-03, 14:05 local time." — for "due this week" and date properties. */
export function todayLine(now = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const day = now.toLocaleDateString('en-US', { weekday: 'long' });
  return `(Today is ${day} ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}, ${p(now.getHours())}:${p(now.getMinutes())} local time.)`;
}

export class ClaudeCliProvider implements Provider {
  readonly id = 'claude';
  readonly label = 'Claude (Pro, claude CLI)';
  readonly locality = 'cloud' as const;
  #o: ClaudeCliOptions;

  constructor(opts: ClaudeCliOptions) {
    this.#o = opts;
  }

  async models(): Promise<ModelInfo[]> {
    return CLAUDE_MODELS;
  }

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    const o = this.#o;
    const meta = await o.store.get(req.chatId);
    const resume = meta?.claudeSessionId !== undefined;
    const sessionId = meta?.claudeSessionId ?? randomUUID();

    const last = req.messages.at(-1);
    const contextUuids = last?.meta?.contextUuids ?? [];
    const context = contextUuids.length > 0 ? await o.renderContext(contextUuids, req.chatId, req.turnId) : '';
    const prompt =
      `${todayLine()}\n\n` +
      (resume ? '' : handoff(req.messages)) +
      (context ? `The user has this open in Logseq (filtered by their privacy settings):\n<context>\n${context}\n</context>\n\n` : '') +
      (last ? messageText(last) : '');

    const mcp = o.sessions.create(req.chatId, req.turnId, 'cloud');
    const mcpConfigPath = join(o.runDir, `mcp-${req.turnId}.json`);
    const toolNames = o.toolNames();
    const expectedTools = new Set(toolNames.map((n) => `mcp__${MCP_SERVER_NAME}__${n}`));
    await writeFile(
      mcpConfigPath,
      JSON.stringify({
        mcpServers: {
          [MCP_SERVER_NAME]: {
            type: 'http',
            url: `${o.bridgeUrl()}/mcp`,
            headers: { Authorization: `Bearer ${mcp.token}` },
            timeout: 900_000,
          },
        },
      }),
      { mode: 0o600 },
    );

    const args = claudeArgs({
      mcpConfigPath,
      allowedTools: [...expectedTools],
      systemPrompt: o.systemPrompt,
      model: req.model,
      effort: req.effort,
      sessionId,
      resume,
      restricted: o.restricted,
    });

    let failure: string | null = null;
    let result: ClaudeEvent | null = null;
    let sawDeltas = false;
    let stderr = '';

    const child = spawn(o.bin, args, { cwd: o.cwd, env: childEnv(), stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    const kill = (why: string): void => {
      if (failure === null && why !== 'cancelled') failure = why;
      if (child.exitCode === null && !child.killed) {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL');
        }, 3000).unref();
      }
    };
    const onAbort = (): void => kill('cancelled');
    req.signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => kill(`claude did not finish within ${Math.round(o.turnTimeoutMs / 1000)} s`), o.turnTimeoutMs);

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      if (stderr.length < 16_000) stderr += d;
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(prompt);

    const handle = (ev: ClaudeEvent): void => {
      if (ev.type === 'system' && ev.subtype === 'init') {
        const tools = Array.isArray(ev.tools) ? (ev.tools as unknown[]).map(String) : [];
        const extra = tools.filter((t) => !expectedTools.has(t));
        if (extra.length > 0) {
          // Defense in depth: never let claude run with anything but our filtered tools.
          kill(`claude started with tools the bridge did not allow (${extra.slice(0, 5).join(', ')}); stopped it`);
          return;
        }
        const servers = Array.isArray(ev.mcp_servers) ? (ev.mcp_servers as { name?: unknown; status?: unknown }[]) : [];
        const ours = servers.find((s) => s.name === MCP_SERVER_NAME);
        if (!ours || ours.status !== 'connected') {
          req.emit({ type: 'notice', message: `claude could not reach the bridge's tools (status: ${String(ours?.status ?? 'missing')}); it will answer without graph access` });
        }
        const keySource = typeof ev.apiKeySource === 'string' ? ev.apiKeySource : 'none';
        if (keySource !== 'none') {
          req.emit({ type: 'notice', message: `claude reports apiKeySource "${keySource}": it may be billing an API key instead of your Pro plan` });
        }
        return;
      }
      if (ev.type === 'stream_event') {
        const inner = ev.event as { type?: string; delta?: { type?: string; text?: string; thinking?: string } } | undefined;
        if (inner?.type === 'content_block_delta') {
          if (inner.delta?.type === 'text_delta' && typeof inner.delta.text === 'string') {
            sawDeltas = true;
            req.emit({ type: 'text.delta', text: inner.delta.text });
          } else if (inner.delta?.type === 'thinking_delta' && typeof inner.delta.thinking === 'string') {
            req.emit({ type: 'thinking.delta', text: inner.delta.thinking });
          }
        }
        return;
      }
      if (ev.type === 'assistant' && !sawDeltas) {
        // Fallback when partial messages are not streamed.
        const content = (ev.message as { content?: unknown } | undefined)?.content;
        if (Array.isArray(content)) {
          for (const c of content as { type?: string; text?: string }[]) {
            if (c.type === 'text' && typeof c.text === 'string') req.emit({ type: 'text.delta', text: c.text });
          }
        }
        return;
      }
      if (ev.type === 'rate_limit_event') {
        const info = ev.rate_limit_info as { status?: unknown } | undefined;
        if (info && info.status !== 'allowed') req.emit({ type: 'notice', message: `Claude usage limit: ${String(info.status)}` });
        return;
      }
      if (ev.type === 'result') result = ev;
    };

    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      if (line.trim() === '') return;
      try {
        handle(JSON.parse(line) as ClaudeEvent);
      } catch {
        log.debug('claude: non-JSON line', { length: line.length });
      }
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on('error', (err) => {
        failure ??= `could not start claude: ${err.message}`;
        resolve(null);
      });
      child.on('close', (code) => resolve(code));
    });
    clearTimeout(timer);
    req.signal.removeEventListener('abort', onAbort);
    o.sessions.revoke(mcp);
    await unlink(mcpConfigPath).catch(() => undefined);

    if (req.signal.aborted) return { stopReason: 'cancelled' };
    const r = result as ClaudeEvent | null;
    if (failure) return { stopReason: 'error', error: failure };
    if (!r) {
      return { stopReason: 'error', error: `claude exited (${String(exitCode)}) without a result${stderr ? `: ${stderr.trim().split('\n').slice(-3).join(' ')}` : ''}` };
    }
    if (r.is_error === true || r.subtype !== 'success') {
      const errs = Array.isArray(r.errors) ? (r.errors as unknown[]).map(String).join('; ') : '';
      const msg = (typeof r.result === 'string' && r.result) || errs || String(r.subtype);
      if (resume && /no conversation found/i.test(msg)) {
        // The saved session is gone; the next turn starts a fresh one.
        await o.store.update(req.chatId, { claudeSessionId: undefined });
      }
      return { stopReason: 'error', error: `claude: ${msg}` };
    }
    if (!sawDeltas && typeof r.result === 'string' && r.result !== '') {
      req.emit({ type: 'text.delta', text: r.result });
    }
    if (!resume) await o.store.update(req.chatId, { claudeSessionId: sessionId });
    const usage = r.usage as Record<string, unknown> | undefined;
    const nums: Record<string, number> = {};
    for (const [k, v] of Object.entries(usage ?? {})) if (typeof v === 'number') nums[k] = v;
    return { stopReason: 'end', usage: nums };
  }
}

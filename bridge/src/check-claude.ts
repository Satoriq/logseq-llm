import { loadOrCreateTokens } from './auth.ts';
import { createRuntime } from './app.ts';
import type { BridgeConfig, DataPaths } from './config.ts';
import type { BridgeEvent } from './events.ts';
import { shutdown } from './http/server.ts';
import { claudeArgs } from './providers/claude-cli.ts';
import type { Effort } from './providers/types.ts';

/**
 * One real claude turn through the whole path: bridge → claude -p (your Pro login)
 * → /mcp → filtered graph tool → answer. Uses a little of your Pro usage.
 */
export async function checkClaude(opts: {
  config: BridgeConfig;
  paths: DataPaths;
  page: string;
  model: string;
  effort: Effort;
  /** Test web search instead of the graph tools. */
  web?: boolean;
  out?: (line: string) => void;
}): Promise<boolean> {
  const out = opts.out ?? ((l: string) => process.stdout.write(l + '\n'));
  const tokens = await loadOrCreateTokens(opts.paths.tokens);
  const rt = await createRuntime({ config: opts.config, paths: opts.paths, tokens });
  const port = await rt.listen(0);
  const preview = claudeArgs({
    mcpConfigPath: '<data>/run/mcp-<turn>.json',
    allowedTools: rt.mcp.toolNames().map((n) => `mcp__lsq__${n}`),
    systemPromptFile: '<data>/run/system-<turn>.md',
    model: opts.model,
    effort: opts.effort,
    sessionId: '<new uuid>',
    resume: false,
    restricted: opts.config.claudeRestricted,
    web: opts.web === true,
  });
  out(`bridge (temporary) on 127.0.0.1:${port}`);
  out(`command: ${opts.config.claudeBin} ${preview.map((a) => (a === '' ? '""' : /\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);

  const chat = await rt.store.create('check-claude');
  const events: BridgeEvent[] = [];
  rt.turns.eventLog(chat.id).subscribe((ev) => {
    events.push(ev);
    if (ev.type === 'tool.start') out(`tool:   ${String(ev.data.label)}`);
    if (ev.type === 'tool.end') out(`        → ${ev.data.ok ? 'ok' : 'error'}: ${String(ev.data.summary)}${ev.data.hiddenCount ? ` (${String(ev.data.hiddenCount)} hidden)` : ''}`);
    if (ev.type === 'notice') out(`notice: ${String(ev.data.message)}`);
    if (ev.type === 'error') out(`error:  ${String(ev.data.message)}`);
  });
  const started = Date.now();
  const { done } = await rt.turns.start(chat.id, {
    text: opts.web
      ? 'Search the web for the latest Logseq desktop release. Reply with its version number and the link you found it at, nothing else.'
      : `Use the get_page tool to read the page "${opts.page}". Then reply with only the number of top-level blocks you can see, as digits.`,
    providerId: 'claude',
    model: opts.model,
    effort: opts.effort,
    contextUuids: [],
    ...(opts.web ? { web: true } : {}),
  });
  await done;
  const text = events.filter((e) => e.type === 'text.delta').map((e) => String(e.data.text)).join('');
  const end = events.find((e) => e.type === 'turn.end');
  const usedTool = events.some((e) => e.type === 'tool.end' && e.data.ok === true);
  out(`answer: ${text.trim() || '(none)'}`);
  out(`result: ${String(end?.data.stopReason)} in ${((Date.now() - started) / 1000).toFixed(1)} s${end?.data.usage ? ` usage ${JSON.stringify(end.data.usage)}` : ''}`);
  await shutdown(rt.server);
  const ok = end?.data.stopReason === 'end' && usedTool && text.trim() !== '';
  out(ok ? '\ncheck-claude: OK' : `\ncheck-claude: FAILED${!usedTool ? ' (no successful tool call)' : ''}`);
  return ok;
}

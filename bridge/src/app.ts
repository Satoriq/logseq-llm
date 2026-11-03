import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { Approvals } from './approvals.ts';
import { AuditLog } from './audit.ts';
import type { Tokens } from './auth.ts';
import { ChatStore } from './chats/store.ts';
import { TurnRunner } from './chats/turns.ts';
import type { BridgeConfig, DataPaths } from './config.ts';
import { GraphReader } from './graph/reader.ts';
import { createBridgeServer, listen } from './http/server.ts';
import { McpEndpoint } from './mcp/endpoint.ts';
import { Policy } from './policy/policy.ts';
import { parseRules } from './policy/rules.ts';
import { ClaudeCliProvider } from './providers/claude-cli.ts';
import { EchoProvider } from './providers/echo.ts';
import { LogseqCli } from './tools/cli.ts';
import { GraphGuard, readTools } from './tools/read.ts';
import type { ToolDef } from './tools/registry.ts';
import { writeTools } from './tools/write.ts';
import type { OwnBlocks } from './tools/write.ts';

/** Wires config → CLI → reader → policy → tools. Shared by `start`, `tool` and `check-claude`. */
export type Graph = {
  cli: LogseqCli;
  reader: GraphReader;
  policy: Policy;
  guard: GraphGuard;
  tools: ToolDef[];
};

/** With `paths`, the write tools are included too (they need the run dir and the audit log). */
export function buildGraph(config: BridgeConfig, paths?: DataPaths, own?: OwnBlocks): Graph {
  const cli = new LogseqCli({ bin: config.logseqBin, writeGraphs: config.writeGraphs, timeoutMs: config.cliTimeoutMs, concurrency: config.cliConcurrency });
  const reader = new GraphReader({ run: (req) => cli.run(req), graph: config.graph });
  const policy = new Policy({ deny: parseRules(config.policy.deny), allow: parseRules(config.policy.allow) });
  const guard = new GraphGuard({ graph: config.graph, serverList: () => cli.serverList() });
  const ensureGraph = (): Promise<void> => guard.ensure();
  const tools = readTools({ reader, policy, ensureGraph, propertyMode: config.readProperties });
  if (paths) {
    tools.push(
      ...writeTools({
        run: (req) => cli.run(req),
        reader,
        policy,
        ensureGraph,
        graph: config.graph,
        writeGraphs: config.writeGraphs,
        runDir: paths.run,
        audit: new AuditLog(paths.audit),
        autoApply: config.graph !== null ? (config.autoApply[config.graph] ?? 'none') : 'none',
        aiTag: config.aiTag,
        ...(own ? { own } : {}),
      }),
    );
  }
  return { cli, reader, policy, guard, tools };
}

export type Runtime = {
  server: Server;
  turns: TurnRunner;
  store: ChatStore;
  mcp: McpEndpoint;
  approvals: Approvals;
  /** Listens on 127.0.0.1:<port> (0 = any free port) and returns the port. */
  listen: (port: number) => Promise<number>;
};

export async function createRuntime(opts: { config: BridgeConfig; paths: DataPaths; tokens: Tokens; graph?: Graph }): Promise<Runtime> {
  const { config, paths, tokens } = opts;
  const store = new ChatStore(paths.chats);
  // Blocks the AI created per chat, kept in the chat's metadata (UUIDs only).
  const own: OwnBlocks = {
    list: async (chatId) => new Set((await store.get(chatId))?.aiCreated ?? []),
    add: async (chatId, uuids) => {
      const meta = await store.get(chatId);
      if (!meta) return;
      const set = new Set(meta.aiCreated ?? []);
      for (const u of uuids) set.add(u.toLowerCase());
      await store.update(chatId, { aiCreated: [...set].slice(-5000) });
    },
  };
  const graph = opts.graph ?? buildGraph(config, paths, own);
  const audit = new AuditLog(paths.audit);
  let port = config.port;
  let turns: TurnRunner | undefined;
  const events = (chatId: string) => (turns as TurnRunner).eventLog(chatId);
  const approvals = new Approvals({ events });
  const mcp = new McpEndpoint({ tools: graph.tools, audit, events, approvals });

  const getBlock = graph.tools.find((t) => t.name === 'get_block');
  const renderContext = async (uuids: string[], chatId: string, turnId: string): Promise<string> => {
    if (!getBlock) return '';
    const parts: string[] = [];
    for (const uuid of uuids.slice(0, 20)) {
      try {
        const out = await getBlock.run({ uuid, depth: 3 }, { locality: 'cloud' });
        if (out.sentUuids.length === 0) continue;
        parts.push(out.text);
        await audit.record({ kind: 'tool', chatId, turnId, tool: 'context', locality: 'cloud', sentUuids: out.sentUuids, hiddenCount: out.hiddenCount });
      } catch {
        // A context block that can't be read is simply left out.
      }
    }
    return parts.join('\n\n');
  };

  const systemPrompt = await readFile(new URL('../prompts/claude-system.md', import.meta.url), 'utf8');
  const claude = new ClaudeCliProvider({
    bin: config.claudeBin,
    cwd: paths.claudeCwd,
    runDir: paths.run,
    bridgeUrl: () => `http://127.0.0.1:${port}`,
    sessions: mcp.sessions,
    toolNames: () => mcp.toolNames(),
    store,
    systemPrompt,
    restricted: config.claudeRestricted,
    renderContext,
    turnTimeoutMs: 15 * 60_000,
  });
  turns = new TurnRunner({
    store,
    providers: [claude, new EchoProvider()],
    audit,
    epoch: randomUUID(),
    // A cancelled or finished turn can't apply anything any more.
    onSettled: (chatId) => approvals.rejectAll(chatId, 'cancelled'),
  });
  const server = createBridgeServer({ port, allowedOrigins: config.allowedOrigins, tokens, store, turns, mcp, approvals });
  return {
    server,
    turns,
    store,
    mcp,
    approvals,
    listen: async (p: number) => {
      port = await listen(server, p);
      return port;
    },
  };
}

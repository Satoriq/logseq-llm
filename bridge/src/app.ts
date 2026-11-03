import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
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

/** Wires config → CLI → reader → policy → tools. Shared by `start`, `tool` and `check-claude`. */
export type Graph = {
  cli: LogseqCli;
  reader: GraphReader;
  policy: Policy;
  guard: GraphGuard;
  tools: ToolDef[];
};

export function buildGraph(config: BridgeConfig): Graph {
  const cli = new LogseqCli({ bin: config.logseqBin, writeGraphs: config.writeGraphs, timeoutMs: config.cliTimeoutMs, concurrency: config.cliConcurrency });
  const reader = new GraphReader({ run: (req) => cli.run(req), graph: config.graph });
  const policy = new Policy({ deny: parseRules(config.policy.deny), allow: parseRules(config.policy.allow) });
  const guard = new GraphGuard({ graph: config.graph, serverList: () => cli.serverList() });
  const tools = readTools({ reader, policy, ensureGraph: () => guard.ensure() });
  return { cli, reader, policy, guard, tools };
}

export type Runtime = {
  server: Server;
  turns: TurnRunner;
  store: ChatStore;
  mcp: McpEndpoint;
  /** Listens on 127.0.0.1:<port> (0 = any free port) and returns the port. */
  listen: (port: number) => Promise<number>;
};

export async function createRuntime(opts: { config: BridgeConfig; paths: DataPaths; tokens: Tokens; graph?: Graph }): Promise<Runtime> {
  const { config, paths, tokens } = opts;
  const graph = opts.graph ?? buildGraph(config);
  const store = new ChatStore(paths.chats);
  const audit = new AuditLog(paths.audit);
  let port = config.port;
  let turns: TurnRunner | undefined;
  const mcp = new McpEndpoint({ tools: graph.tools, audit, events: (chatId) => (turns as TurnRunner).eventLog(chatId) });

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
  turns = new TurnRunner({ store, providers: [claude, new EchoProvider()], audit, epoch: randomUUID() });
  const server = createBridgeServer({ port, allowedOrigins: config.allowedOrigins, tokens, store, turns, mcp });
  return {
    server,
    turns,
    store,
    mcp,
    listen: async (p: number) => {
      port = await listen(server, p);
      return port;
    },
  };
}

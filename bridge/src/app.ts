import type { BridgeConfig } from './config.ts';
import { GraphReader } from './graph/reader.ts';
import { Policy } from './policy/policy.ts';
import { parseRules } from './policy/rules.ts';
import { LogseqCli } from './tools/cli.ts';
import { GraphGuard, readTools } from './tools/read.ts';
import type { ToolDef } from './tools/registry.ts';

/** Wires config → CLI → reader → policy → tools. Shared by `start`, `tool` and (1c) the MCP endpoint. */
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

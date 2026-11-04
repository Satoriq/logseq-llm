import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../../src/app.ts';
import type { Graph, Runtime } from '../../src/app.ts';
import { loadOrCreateTokens } from '../../src/auth.ts';
import type { Tokens } from '../../src/auth.ts';
import { dataPaths, defaultConfig, ensureDataDirs, mergeConfig } from '../../src/config.ts';
import type { DataPaths } from '../../src/config.ts';
import { GraphReader } from '../../src/graph/reader.ts';
import { connectClient, readClientTokens } from '../../src/mcp/clients.ts';
import { Policy } from '../../src/policy/policy.ts';
import { LogseqCli } from '../../src/tools/cli.ts';
import { GraphGuard, readTools } from '../../src/tools/read.ts';
import type { ToolDef } from '../../src/tools/registry.ts';
import { FakeLogseq } from './fake-graph.ts';

/** Stands in for a write tool: shows a card, then reports the answer the way the real ones do. */
export const cardTool: ToolDef = {
  name: 'insert_blocks',
  description: 'write',
  inputSchema: { type: 'object' },
  kind: 'write',
  label: () => 'write',
  run: async (_args, ctx) => {
    if (!ctx.approve) throw new Error('no approve in the tool context');
    const { view, decision } = await ctx.approve({ tool: 'insert_blocks', title: 'Add a block', target: 'page "AI Test"', body: { kind: 'text', text: 'x' }, warnings: [] });
    const outcome = decision.decision === 'apply' ? 'applied' : 'rejected';
    ctx.resolved?.(view, outcome, decision.reason ?? '');
    return { text: outcome === 'applied' ? 'Applied: added a block' : `Not applied: ${decision.reason ?? ''}`, sentUuids: [], hiddenCount: 0 };
  },
};

/** A bridge on the fake graph with Claude Desktop connected. Nothing listens until you call rt.listen. */
export async function clientRuntime(): Promise<{ rt: Runtime; paths: DataPaths; home: string; token: string; tokens: Tokens }> {
  const paths = dataPaths(await mkdtemp(join(tmpdir(), 'lsai-clients-')));
  const home = await mkdtemp(join(tmpdir(), 'lsai-home-'));
  await ensureDataDirs(paths);
  const tokens = await loadOrCreateTokens(paths.tokens);
  const config = mergeConfig(defaultConfig(), { graph: 'AI Sandbox' });
  const fake = new FakeLogseq();
  const reader = new GraphReader({ run: fake.run, graph: 'AI Sandbox' });
  const policy = new Policy({ deny: [], allow: [] });
  const guard = new GraphGuard({ graph: 'AI Sandbox', serverList: fake.serverList });
  // Write tools next to the reads, as in a real graph. Memory must stay out of a connected app's reach.
  const remember: ToolDef = {
    name: 'remember',
    description: 'memory',
    inputSchema: { type: 'object' },
    kind: 'write',
    label: () => 'memory',
    run: async () => {
      throw new Error('a connected app reached the memory tools');
    },
  };
  const graph: Graph = {
    cli: new LogseqCli({ bin: '/bin/false', writeGraphs: [], timeoutMs: 1000, concurrency: 1 }),
    reader,
    policy,
    guard,
    tools: [...readTools({ reader, policy, ensureGraph: () => guard.ensure() }), cardTool, remember],
  };
  const rt = await createRuntime({ config, paths, tokens, graph });
  await connectClient('claude-desktop', { tokensFile: paths.mcpClients, home, node: '/opt/node', script: '/opt/bridge.ts' });
  return { rt, paths, home, tokens, token: (await readClientTokens(paths.mcpClients))['claude-desktop'] as string };
}

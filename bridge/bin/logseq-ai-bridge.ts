#!/usr/bin/env node
import { loadOrCreateTokens, rotateTokens } from '../src/auth.ts';
import { AuditLog } from '../src/audit.ts';
import { BRIDGE_NAME, BRIDGE_VERSION, dataPaths, defaultDataDir, ensureDataDirs, loadConfig, MIN_NODE_MAJOR } from '../src/config.ts';
import { buildGraph, createRuntime } from '../src/app.ts';
import { checkClaude } from '../src/check-claude.ts';
import { runDoctor } from '../src/doctor.ts';
import { shutdown } from '../src/http/server.ts';
import { log } from '../src/log.ts';
import { CLAUDE_MODELS } from '../src/providers/claude-cli.ts';
import { isEffort } from '../src/providers/types.ts';

const USAGE = `${BRIDGE_NAME} ${BRIDGE_VERSION}

Usage:
  node bin/logseq-ai-bridge.ts start [--port <n>]
  node bin/logseq-ai-bridge.ts doctor [--sample-page "<title>"] [--sample-search "<text>"]
  node bin/logseq-ai-bridge.ts check-claude [--page "<title>"] [--model sonnet] [--effort low]
                                               one real claude turn through the bridge (uses a little Pro usage)
  node bin/logseq-ai-bridge.ts tools          list the graph tools models get
  node bin/logseq-ai-bridge.ts tool <name> ['<json args>'] [--as cloud|local]
                                               run one tool and print exactly what a model would see
  node bin/logseq-ai-bridge.ts token          print the plugin token (paste it into the plugin settings)
  node bin/logseq-ai-bridge.ts rotate-token   make new tokens (the old ones stop working)

Data dir: ${defaultDataDir()}  (override with LOGSEQ_AI_DATA_DIR)`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('--')) throw new Error(`${name} needs a value`);
  return v;
}

function checkNode(): void {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < MIN_NODE_MAJOR && process.env.LOGSEQ_AI_ALLOW_ANY_NODE !== '1') {
    process.stderr.write(`${BRIDGE_NAME} needs Node >= ${MIN_NODE_MAJOR}; this is ${process.version} (${process.execPath}).\n`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === undefined || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    process.stdout.write(USAGE + '\n');
    return;
  }
  checkNode();
  const paths = dataPaths(defaultDataDir());
  await ensureDataDirs(paths);

  if (cmd === 'token') {
    const tokens = await loadOrCreateTokens(paths.tokens);
    process.stdout.write(tokens.plugin + '\n');
    return;
  }
  if (cmd === 'rotate-token') {
    await rotateTokens(paths.tokens);
    process.stdout.write('New tokens written. Restart the bridge and paste the new plugin token into the plugin settings.\n');
    return;
  }

  const config = await loadConfig(paths);

  if (cmd === 'doctor') {
    const ok = await runDoctor({
      config,
      paths,
      ...(flag(args, '--sample-page') !== undefined ? { samplePage: flag(args, '--sample-page') as string } : {}),
      ...(flag(args, '--sample-search') !== undefined ? { sampleSearch: flag(args, '--sample-search') as string } : {}),
    });
    process.exitCode = ok ? 0 : 1;
    return;
  }

  if (cmd === 'check-claude') {
    const model = flag(args, '--model') ?? 'sonnet';
    if (!CLAUDE_MODELS.some((m) => m.id === model)) throw new Error(`--model must be one of ${CLAUDE_MODELS.map((m) => m.id).join(', ')}`);
    const effort = flag(args, '--effort') ?? 'low';
    if (!isEffort(effort) || effort === 'off') throw new Error('--effort must be auto, low, medium, high, xhigh or max');
    const ok = await checkClaude({ config, paths, page: flag(args, '--page') ?? 'AI Test', model, effort });
    process.exitCode = ok ? 0 : 1;
    return;
  }

  if (cmd === 'tools') {
    for (const t of buildGraph(config).tools) process.stdout.write(`${t.name} (${t.kind})\n  ${t.description}\n`);
    return;
  }

  if (cmd === 'tool') {
    const name = args[0];
    if (name === undefined || name.startsWith('--')) throw new Error('usage: tool <name> [\'<json args>\'] [--as cloud|local]');
    const rawArgs = args[1] !== undefined && !args[1].startsWith('--') ? args[1] : '{}';
    const as = flag(args, '--as') ?? 'cloud';
    if (as !== 'cloud' && as !== 'local') throw new Error('--as must be cloud or local');
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawArgs);
    } catch {
      throw new Error('tool arguments must be JSON, e.g. \'{"title":"AI Test"}\'');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('tool arguments must be a JSON object');
    const graph = buildGraph(config);
    const tool = graph.tools.find((t) => t.name === name);
    if (!tool) throw new Error(`unknown tool "${name}" (see: tools)`);
    const out = await tool.run(parsed as Record<string, unknown>, { locality: as });
    process.stdout.write(out.text + '\n');
    process.stderr.write(`--- ${as} view: ${out.sentUuids.length} item(s) sent, ${out.hiddenCount} hidden by the privacy filter\n`);
    await new AuditLog(paths.audit).record({ kind: 'tool', chatId: 'cli', tool: tool.name, locality: as, sentUuids: out.sentUuids, hiddenCount: out.hiddenCount });
    return;
  }

  if (cmd === 'start') {
    const portArg = flag(args, '--port');
    const port = portArg !== undefined ? Number(portArg) : config.port;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('--port must be 1024-65535');
    const tokens = await loadOrCreateTokens(paths.tokens);
    const { server, turns, listen } = await createRuntime({ config, paths, tokens });
    const actual = await listen(port);
    log.info(`${BRIDGE_NAME} ${BRIDGE_VERSION} listening on http://127.0.0.1:${actual}`, {
      dataDir: paths.root,
      allowedOrigins: config.allowedOrigins,
      graph: config.graph,
    });
    const stop = (): void => {
      log.info('shutting down');
      turns.cancelAll();
      void shutdown(server).then(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    return;
  }

  process.stderr.write(`unknown command "${cmd}"\n\n${USAGE}\n`);
  process.exitCode = 2;
}

main().catch((err: unknown) => {
  process.stderr.write(`${BRIDGE_NAME}: ${(err as Error).message}\n`);
  process.exit(1);
});

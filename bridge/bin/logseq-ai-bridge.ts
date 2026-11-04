#!/usr/bin/env node
import { homedir } from 'node:os';
import { loadOrCreateTokens, rotateTokens } from '../src/auth.ts';
import { AuditLog } from '../src/audit.ts';
import { BRIDGE_NAME, BRIDGE_VERSION, dataPaths, defaultDataDir, ensureDataDirs, loadConfig, MIN_NODE_MAJOR } from '../src/config.ts';
import { buildGraph, createRuntime } from '../src/app.ts';
import { BRIDGE_SCRIPT, defaultAgentDeps, runAgent } from '../src/agent.ts';
import { checkClaude } from '../src/check-claude.ts';
import { runDoctor } from '../src/doctor.ts';
import { shutdown } from '../src/http/server.ts';
import { addKeyCommand, keychain } from '../src/keychain.ts';
import { log } from '../src/log.ts';
import { connectClient, disconnectClient, isMcpClient, MCP_CLIENTS, readClientTokens } from '../src/mcp/clients.ts';
import { runStdio } from '../src/mcp/stdio.ts';
import { API_PRESETS } from '../src/providers/api.ts';
import { CLAUDE_MODELS } from '../src/providers/claude-cli.ts';
import { isEffort } from '../src/providers/types.ts';

const USAGE = `${BRIDGE_NAME} ${BRIDGE_VERSION}

Usage:
  node bin/logseq-ai-bridge.ts start [--port <n>]
  node bin/logseq-ai-bridge.ts doctor [--sample-page "<title>"] [--sample-search "<text>"]
  node bin/logseq-ai-bridge.ts check-claude [--page "<title>"] [--model sonnet] [--effort low] [--web]
                                               one real claude turn through the bridge (uses a little Pro usage);
                                               --web tests web search instead of the graph tools
  node bin/logseq-ai-bridge.ts tools          list the graph tools models get
  node bin/logseq-ai-bridge.ts tool <name> ['<json args>'] [--as cloud|local]
                                               run one tool and print exactly what a model would see
  node bin/logseq-ai-bridge.ts agent install|restart|status|uninstall
                                               macOS: start the bridge at login (and after a crash)
  node bin/logseq-ai-bridge.ts connect ${MCP_CLIENTS.join('|')}
                                               let that app use the graph tools (privacy-filtered; writes need your approval); changes its config file
  node bin/logseq-ai-bridge.ts disconnect ${MCP_CLIENTS.join('|')}
                                               cut that app off at once and remove it from its config file
  node bin/logseq-ai-bridge.ts token          print the plugin token (paste it into the plugin settings)
  node bin/logseq-ai-bridge.ts rotate-token   make new tokens (the old ones stop working)
  node bin/logseq-ai-bridge.ts keys           which API keys are set, and how to add one

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
  if (cmd === 'keys') {
    for (const p of API_PRESETS) {
      const set = await keychain.has(p.key);
      process.stdout.write(`${set ? 'set    ' : 'not set'}  ${p.label}\n`);
      if (!set) process.stdout.write(`         get a key: ${p.keysPage}\n         then run:  ${addKeyCommand(p.key)}\n`);
    }
    process.stdout.write('\nThe key is asked for at a hidden prompt. The panel offers a provider within 30 seconds of its key being added.\n');
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
    const ok = await checkClaude({ config, paths, page: flag(args, '--page') ?? 'AI Test', model, effort, web: args.includes('--web') });
    process.exitCode = ok ? 0 : 1;
    return;
  }

  if (cmd === 'agent') {
    const ok = await runAgent(args[0] ?? '', defaultAgentDeps({ dataDir: paths.root, logDir: paths.logs, port: config.port }));
    process.exitCode = ok ? 0 : 1;
    return;
  }

  if (cmd === 'connect' || cmd === 'disconnect') {
    const client = args[0];
    if (!isMcpClient(client)) throw new Error(`${cmd}: name an app: ${MCP_CLIENTS.join(' or ')}`);
    const opts = { tokensFile: paths.mcpClients, home: homedir() };
    const file = cmd === 'connect' ? await connectClient(client, { ...opts, node: process.execPath, script: BRIDGE_SCRIPT }) : await disconnectClient(client, opts);
    process.stdout.write(`${cmd === 'connect' ? 'Connected' : 'Disconnected'} ${client} (changed ${file}; the old version is next to it, ending in .logseq-ai.bak).\n`);
    process.stdout.write(cmd === 'connect' ? 'Quit and reopen the app. No bridge restart is needed.\n' : 'Its token stopped working right away.\n');
    return;
  }

  // Started by Claude Desktop or Codex. stdout carries MCP messages only.
  if (cmd === 'mcp') {
    const client = args[0];
    if (!isMcpClient(client)) throw new Error(`mcp: name an app: ${MCP_CLIENTS.join(' or ')}`);
    await runStdio({ port: config.port, token: async () => (await readClientTokens(paths.mcpClients))[client], input: process.stdin, output: process.stdout });
    return;
  }

  if (cmd === 'tools') {
    for (const t of buildGraph(config, paths).tools) process.stdout.write(`${t.name} (${t.kind})\n  ${t.description}\n`);
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
    const graph = buildGraph(config, paths);
    const tool = graph.tools.find((t) => t.name === name);
    if (!tool) throw new Error(`unknown tool "${name}" (see: tools)`);
    // Write tools: print the approval card, then decline. Applying a change needs the panel.
    const out = await tool.run(parsed as Record<string, unknown>, {
      locality: as,
      approve: async (req) => {
        process.stdout.write(`--- approval card (preview only; writes are applied from the panel)\n${req.title}\nwhere: ${req.target}\n`);
        const b = req.body;
        if (b.kind === 'diff') process.stdout.write(`before: ${b.before}\nafter:  ${b.after}\n`);
        else if (b.kind === 'diffs') for (const d of b.items) process.stdout.write(`before: ${d.before}\nafter:  ${d.after}\n`);
        else process.stdout.write(`${b.text}\n`);
        for (const w of req.warnings) process.stdout.write(`warning: ${w}\n`);
        process.stdout.write('---\n');
        return { view: { ...req, id: 'preview', chatId: 'cli', turnId: 'cli', createdAt: Date.now() }, decision: { decision: 'reject', reason: 'user', note: 'preview only' } };
      },
    });
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
    let actual: number;
    try {
      actual = await listen(port);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
      process.stderr.write(`${BRIDGE_NAME}: port ${port} is already in use (another bridge running?).\n`);
      // Under the login agent, exit "successfully" so launchd doesn't retry every 10 s.
      process.exit(process.env.LOGSEQ_AI_AGENT === '1' ? 0 : 1);
    }
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

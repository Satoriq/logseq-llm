#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { loadOrCreateTokens, rotateTokens } from '../src/auth.ts';
import { AuditLog } from '../src/audit.ts';
import { ChatStore } from '../src/chats/store.ts';
import { TurnRunner } from '../src/chats/turns.ts';
import { BRIDGE_NAME, BRIDGE_VERSION, dataPaths, defaultDataDir, ensureDataDirs, loadConfig, MIN_NODE_MAJOR } from '../src/config.ts';
import { runDoctor } from '../src/doctor.ts';
import { createBridgeServer, listen, shutdown } from '../src/http/server.ts';
import { log } from '../src/log.ts';
import { EchoProvider } from '../src/providers/echo.ts';

const USAGE = `${BRIDGE_NAME} ${BRIDGE_VERSION}

Usage:
  node bin/logseq-ai-bridge.ts start [--port <n>]
  node bin/logseq-ai-bridge.ts doctor [--sample-page "<title>"] [--sample-search "<text>"]
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

  if (cmd === 'start') {
    const portArg = flag(args, '--port');
    const port = portArg !== undefined ? Number(portArg) : config.port;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('--port must be 1024-65535');
    const tokens = await loadOrCreateTokens(paths.tokens);
    const store = new ChatStore(paths.chats);
    const audit = new AuditLog(paths.audit);
    const turns = new TurnRunner({ store, providers: [new EchoProvider()], audit, epoch: randomUUID() });
    const server = createBridgeServer({ port, allowedOrigins: config.allowedOrigins, tokens, store, turns });
    const actual = await listen(server, port);
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

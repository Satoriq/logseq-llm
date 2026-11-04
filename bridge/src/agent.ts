import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Start the bridge at login with a macOS LaunchAgent (plan §6, approved).
 *
 * `agent install` writes ONE file, ~/Library/LaunchAgents/local.logseq-ai.bridge.plist,
 * and loads it into your login session with launchctl. That session has your Keychain,
 * so claude's Pro login keeps working. launchd restarts the bridge if it crashes (not when it
 * exits cleanly). Output goes to <data>/logs/bridge.log. `agent uninstall` removes it all.
 *
 * Only launchctl is run, with fixed arguments (no shell).
 */

export const AGENT_LABEL = 'local.logseq-ai.bridge';
const MAX_LOG_BYTES = 5 * 1024 * 1024;

export type AgentDeps = {
  platform: string;
  home: string;
  uid: number;
  /** Absolute path of the Node that runs this command; the agent will use the same one. */
  node: string;
  /** PATH and LANG from your Terminal, so the logseq and claude CLIs behave as when you tested them. */
  env: { PATH?: string; LANG?: string; LOGSEQ_AI_DATA_DIR?: string };
  dataDir: string;
  logDir: string;
  port: number;
  launchctl: (args: string[]) => Promise<{ ok: boolean; out: string }>;
  /** True if a bridge answers /v1/health on the port. */
  health: () => Promise<boolean>;
  sleep: (ms: number) => Promise<void>;
  out: (line: string) => void;
};

export const BRIDGE_SCRIPT = fileURLToPath(new URL('../bin/logseq-ai-bridge.ts', import.meta.url));

function xml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function agentPlistPath(home: string): string {
  return join(home, 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`);
}

export function agentLogPath(logDir: string): string {
  return join(logDir, 'bridge.log');
}

/** The LaunchAgent property list. Every value is XML-escaped; paths with spaces are fine. */
export function agentPlist(o: { node: string; script: string; logFile: string; env: AgentDeps['env'] }): string {
  for (const p of [o.node, o.script, o.logFile]) {
    if (!isAbsolute(p) || /[\n\r\0]/.test(p)) throw new Error(`not a usable absolute path: ${p}`);
  }
  const str = (v: string): string => `<string>${xml(v)}</string>`;
  // The Node's own folder first, so a `#!/usr/bin/env node` CLI finds the same Node.
  const path = [dirname(o.node), ...(o.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin').split(':')].filter((p, i, a) => p !== '' && a.indexOf(p) === i).join(':');
  const env: [string, string][] = [
    ['LOGSEQ_AI_AGENT', '1'],
    ['PATH', path],
    ...(o.env.LANG ? ([['LANG', o.env.LANG]] as [string, string][]) : []),
    ...(o.env.LOGSEQ_AI_DATA_DIR ? ([['LOGSEQ_AI_DATA_DIR', o.env.LOGSEQ_AI_DATA_DIR]] as [string, string][]) : []),
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key>${str(AGENT_LABEL)}`,
    `  <key>ProgramArguments</key><array>${str(o.node)}${str(o.script)}${str('start')}</array>`,
    `  <key>WorkingDirectory</key>${str(dirname(dirname(o.script)))}`,
    `  <key>EnvironmentVariables</key><dict>${env.map(([k, v]) => `<key>${xml(k)}</key>${str(v)}`).join('')}</dict>`,
    '  <key>RunAtLoad</key><true/>',
    // Restart after a crash, not after a clean exit (e.g. port already taken by a Terminal bridge).
    '  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>',
    '  <key>ThrottleInterval</key><integer>10</integer>',
    `  <key>StandardOutPath</key>${str(o.logFile)}`,
    `  <key>StandardErrorPath</key>${str(o.logFile)}`,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export function realLaunchctl(args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile('/bin/launchctl', args, { shell: false, timeout: 15000, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout}${stderr}`.trim() });
    });
  });
}

export function defaultAgentDeps(o: { dataDir: string; logDir: string; port: number }): AgentDeps {
  return {
    platform: process.platform,
    home: homedir(),
    uid: process.getuid?.() ?? -1,
    node: process.execPath,
    env: {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
      ...(process.env.LOGSEQ_AI_DATA_DIR ? { LOGSEQ_AI_DATA_DIR: process.env.LOGSEQ_AI_DATA_DIR } : {}),
    },
    dataDir: o.dataDir,
    logDir: o.logDir,
    port: o.port,
    launchctl: realLaunchctl,
    health: async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${o.port}/v1/health`, { signal: AbortSignal.timeout(1500) });
        return r.ok;
      } catch {
        return false;
      }
    },
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    out: (l) => process.stdout.write(l + '\n'),
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function waitHealthy(d: AgentDeps, seconds: number): Promise<boolean> {
  for (let i = 0; i < seconds * 2; i++) {
    if (await d.health()) return true;
    await d.sleep(500);
  }
  return false;
}

async function tail(file: string, lines: number): Promise<string[]> {
  try {
    return (await readFile(file, 'utf8')).trimEnd().split('\n').slice(-lines);
  } catch {
    return [];
  }
}

/** Keeps the log from growing forever: emptied when it passes 5 MB, at (re)start. */
async function trimLog(file: string): Promise<void> {
  try {
    if ((await stat(file)).size > MAX_LOG_BYTES) await truncate(file, 0);
  } catch {
    // no log yet
  }
}

export async function runAgent(cmd: string, d: AgentDeps): Promise<boolean> {
  if (d.platform !== 'darwin') {
    d.out('agent: LaunchAgents are a macOS feature. On this system, run "start" yourself.');
    return false;
  }
  if (d.uid < 0) throw new Error('agent: could not tell your user id');
  const plist = agentPlistPath(d.home);
  const log = agentLogPath(d.logDir);
  const target = `gui/${d.uid}`;
  const service = `${target}/${AGENT_LABEL}`;
  const loaded = async (): Promise<boolean> => (await d.launchctl(['print', service])).ok;

  if (cmd === 'install') {
    if (!(await loaded()) && (await d.health())) {
      d.out(`agent: a bridge is already running on port ${d.port} (probably in a Terminal window). Stop it with Ctrl-C, then run "agent install" again.`);
      return false;
    }
    if (await loaded()) await d.launchctl(['bootout', service]);
    await mkdir(dirname(plist), { recursive: true });
    await mkdir(d.logDir, { recursive: true, mode: 0o700 });
    // launchd refuses plists that others can write.
    await writeFile(plist, agentPlist({ node: d.node, script: BRIDGE_SCRIPT, logFile: log, env: d.env }), { mode: 0o644 });
    await trimLog(log);
    const r = await d.launchctl(['bootstrap', target, plist]);
    if (!r.ok) {
      d.out(`agent: launchctl bootstrap failed: ${r.out}`);
      return false;
    }
    const ok = await waitHealthy(d, 10);
    d.out(`agent: installed ${plist}`);
    d.out(`       runs: ${d.node} ${BRIDGE_SCRIPT} start`);
    d.out(`       log:  ${log}`);
    d.out(ok ? `agent: the bridge is running on port ${d.port} and will start at every login.` : `agent: installed, but the bridge didn't answer yet. Check: agent status`);
    return ok;
  }

  if (cmd === 'uninstall') {
    if (await loaded()) await d.launchctl(['bootout', service]);
    await rm(plist, { force: true });
    d.out(`agent: removed. Start the bridge yourself from now on ("start").`);
    return true;
  }

  if (cmd === 'restart') {
    if (!(await exists(plist))) {
      d.out('agent: not installed. Run "agent install" first.');
      return false;
    }
    // Reload from the file, so a re-pulled bridge or changed settings take effect.
    if (await loaded()) await d.launchctl(['bootout', service]);
    await trimLog(log);
    const r = await d.launchctl(['bootstrap', target, plist]);
    if (!r.ok) {
      d.out(`agent: launchctl bootstrap failed: ${r.out}`);
      return false;
    }
    const ok = await waitHealthy(d, 10);
    d.out(ok ? 'agent: restarted.' : 'agent: restarted, but the bridge does not answer. Check: agent status');
    return ok;
  }

  if (cmd === 'status') {
    const installed = await exists(plist);
    const p = await d.launchctl(['print', service]);
    const state = /\bstate = (\w+)/.exec(p.out)?.[1];
    const pid = /\bpid = (\d+)/.exec(p.out)?.[1];
    const lastExit = /last exit code = ([^\n]+)/.exec(p.out)?.[1];
    const up = await d.health();
    d.out(`agent: ${installed ? 'installed' : 'not installed'}${p.ok ? `, loaded (${state ?? '?'}${pid ? `, pid ${pid}` : ''}${lastExit ? `, last exit ${lastExit.trim()}` : ''})` : ', not loaded'}`);
    d.out(`bridge: ${up ? `answering on port ${d.port}` : `not answering on port ${d.port}`}`);
    const lines = await tail(log, 15);
    if (lines.length) d.out(`last log lines (${log}):\n${lines.map((l) => `  ${l}`).join('\n')}`);
    return installed && up;
  }

  d.out('usage: agent install | uninstall | restart | status');
  return false;
}

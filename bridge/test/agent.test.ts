import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AGENT_LABEL, agentPlist, agentPlistPath, BRIDGE_SCRIPT, runAgent } from '../src/agent.ts';
import type { AgentDeps } from '../src/agent.ts';

async function deps(over: Partial<AgentDeps> = {}) {
  const home = await mkdtemp(join(tmpdir(), 'lsai-agent-'));
  const calls: string[][] = [];
  let loaded = false;
  let up = false;
  const lines: string[] = [];
  const d: AgentDeps = {
    platform: 'darwin',
    home,
    uid: 501,
    node: '/opt/homebrew/bin/node',
    env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin', LANG: 'uk_UA.UTF-8' },
    dataDir: join(home, 'data'),
    logDir: join(home, 'data', 'logs'),
    port: 47615,
    launchctl: async (args) => {
      calls.push(args);
      if (args[0] === 'print') return { ok: loaded, out: loaded ? 'state = running\n\tpid = 4242\n' : 'Could not find service' };
      if (args[0] === 'bootstrap') {
        loaded = true;
        up = true;
      }
      if (args[0] === 'bootout') {
        loaded = false;
        up = false;
      }
      return { ok: true, out: '' };
    },
    health: async () => up,
    sleep: async () => {},
    out: (l) => lines.push(l),
    ...over,
  };
  return { d, calls, lines, home, setUp: (v: boolean) => (up = v) };
}

test('agent plist: exact program, escaped paths, restart only after a crash', () => {
  const p = agentPlist({ node: '/Users/lol/n & m/node', script: '/Users/lol/Chrome/logseq AI/logseq-llm/bridge/bin/logseq-ai-bridge.ts', logFile: '/Users/lol/Library/Application Support/logseq-ai/logs/bridge.log', env: { PATH: '/usr/bin:/bin' } });
  assert.match(p, new RegExp(`<key>Label</key><string>${AGENT_LABEL.replace(/\./g, '\\.')}</string>`));
  assert.match(p, /<array><string>\/Users\/lol\/n &amp; m\/node<\/string><string>\/Users\/lol\/Chrome\/logseq AI\/logseq-llm\/bridge\/bin\/logseq-ai-bridge\.ts<\/string><string>start<\/string><\/array>/);
  assert.match(p, /<key>WorkingDirectory<\/key><string>\/Users\/lol\/Chrome\/logseq AI\/logseq-llm\/bridge<\/string>/);
  assert.match(p, /<key>PATH<\/key><string>\/Users\/lol\/n &amp; m:\/usr\/bin:\/bin<\/string>/, "the Node's folder comes first");
  assert.match(p, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/);
  assert.match(p, /<key>LOGSEQ_AI_AGENT<\/key><string>1<\/string>/);
  assert.throws(() => agentPlist({ node: 'node', script: BRIDGE_SCRIPT, logFile: '/x.log', env: {} }), /absolute/);
});

test('agent install / status / restart / uninstall run only launchctl, with fixed arguments', async () => {
  const { d, calls, lines } = await deps();
  assert.equal(await runAgent('install', d), true);
  const plist = agentPlistPath(d.home);
  assert.equal((await stat(plist)).mode & 0o777, 0o644);
  assert.match(await readFile(plist, 'utf8'), /<string>\/opt\/homebrew\/bin\/node<\/string>/);
  assert.deepEqual(calls.find((c) => c[0] === 'bootstrap'), ['bootstrap', 'gui/501', plist]);
  assert.ok(lines.some((l) => /will start at every login/.test(l)));

  lines.length = 0;
  assert.equal(await runAgent('status', d), true);
  assert.match(lines[0] ?? '', /installed, loaded \(running, pid 4242\)/);

  // A big log is emptied at restart.
  const log = join(d.logDir, 'bridge.log');
  await writeFile(log, 'x'.repeat(6 * 1024 * 1024));
  assert.equal(await runAgent('restart', d), true);
  assert.equal((await stat(log)).size, 0);
  assert.ok(calls.some((c) => c[0] === 'bootout' && c[1] === `gui/501/${AGENT_LABEL}`));

  assert.equal(await runAgent('uninstall', d), true);
  await assert.rejects(stat(plist));
  for (const c of calls) assert.ok(['print', 'bootstrap', 'bootout'].includes(c[0] as string), `unexpected launchctl ${c.join(' ')}`);
});

test('agent install refuses while a Terminal bridge holds the port; not on Linux', async () => {
  const a = await deps();
  a.setUp(true);
  assert.equal(await runAgent('install', a.d), false);
  assert.match(a.lines.join('\n'), /already running .*Ctrl-C/);
  assert.ok(!a.calls.some((c) => c[0] === 'bootstrap'));
  const b = await deps({ platform: 'linux' });
  assert.equal(await runAgent('install', b.d), false);
  assert.match(b.lines.join('\n'), /macOS feature/);
});

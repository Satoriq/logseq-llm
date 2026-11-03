import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bearerFrom, loadOrCreateTokens, rotateTokens, scopeForToken, tokenEquals } from '../src/auth.ts';
import { dataPaths, defaultConfig, ensureDataDirs, loadConfig, mergeConfig } from '../src/config.ts';
import { EventLog } from '../src/events.ts';

async function tempPaths() {
  const root = await mkdtemp(join(tmpdir(), 'lsai-test-'));
  const paths = dataPaths(root);
  await ensureDataDirs(paths);
  return paths;
}

test('tokens: constant-time compare and bearer parsing', () => {
  assert.equal(tokenEquals('a'.repeat(43), 'a'.repeat(43)), true);
  assert.equal(tokenEquals('a'.repeat(43), 'b'.repeat(43)), false);
  assert.equal(tokenEquals('short', 'a'.repeat(43)), false);
  assert.equal(bearerFrom('Bearer ' + 'x'.repeat(43)), 'x'.repeat(43));
  assert.equal(bearerFrom('Basic abc'), null);
  assert.equal(bearerFrom('Bearer has spaces in it'), null);
  assert.equal(bearerFrom(undefined), null);
});

test('tokens: created once with mode 0600, scoped, rotatable', async () => {
  const paths = await tempPaths();
  const t1 = await loadOrCreateTokens(paths.tokens);
  const t2 = await loadOrCreateTokens(paths.tokens);
  assert.deepEqual(t1, t2);
  assert.notEqual(t1.plugin, t1.voice);
  assert.equal((await stat(paths.tokens)).mode & 0o777, 0o600);
  assert.equal(scopeForToken(t1.plugin, t1), 'plugin');
  assert.equal(scopeForToken(t1.voice, t1), 'voice');
  assert.equal(scopeForToken('nope'.repeat(10), t1), null);
  const t3 = await rotateTokens(paths.tokens);
  assert.notEqual(t3.plugin, t1.plugin);
});

test('config: defaults are written on first load, unknown keys refused', async () => {
  const paths = await tempPaths();
  const cfg = await loadConfig(paths);
  assert.deepEqual(cfg, defaultConfig());
  assert.equal((await stat(paths.config)).mode & 0o777, 0o600);
  assert.ok(JSON.parse(await readFile(paths.config, 'utf8')).port);
  assert.throws(() => mergeConfig(defaultConfig(), { prot: 1 }), /unknown key/);
  assert.throws(() => mergeConfig(defaultConfig(), { allowedOrigins: ['*'] }), /not allowed/);
  assert.throws(() => mergeConfig(defaultConfig(), { allowedOrigins: ['null'] }), /not allowed/);
  assert.throws(() => mergeConfig(defaultConfig(), { logseqBin: 'logseq' }), /absolute/);
  assert.throws(() => mergeConfig(defaultConfig(), { port: 80 }), /port/);
  assert.throws(() => mergeConfig(defaultConfig(), { policy: { block: [] } }), /policy key/);
  assert.throws(() => mergeConfig(defaultConfig(), { autoApply: { 'AI Sandbox': 'everything' } }), /autoApply/);
  assert.deepEqual(mergeConfig(defaultConfig(), { autoApply: { 'AI Sandbox': 'additions' } }).autoApply, { 'AI Sandbox': 'additions' });
  const merged = mergeConfig(defaultConfig(), { graph: 'Sandbox', writeGraphs: ['Sandbox'], logseqBin: '~/bin/logseq' });
  assert.equal(merged.graph, 'Sandbox');
  assert.ok(merged.logseqBin.endsWith('/bin/logseq') && !merged.logseqBin.startsWith('~'));
});

test('data dirs are owner-only', async () => {
  const paths = await tempPaths();
  for (const d of [paths.root, paths.secrets, paths.chats]) {
    assert.equal((await stat(d)).mode & 0o777, 0o700, d);
  }
});

test('event log: sequence, since, gap, wait', async () => {
  const log = new EventLog('epoch-1', 3);
  log.append('a');
  log.append('b');
  assert.deepEqual(log.since(0).events.map((e) => e.type), ['a', 'b']);
  assert.equal(log.since(1).events.length, 1);
  log.append('c');
  log.append('d'); // 'a' (seq 1) is dropped
  assert.equal(log.since(0).gap, true);
  assert.equal(log.since(1).gap, false);
  const waiting = log.waitForNew(4, 2000);
  setTimeout(() => log.append('e'), 10);
  const t0 = Date.now();
  await waiting;
  assert.ok(Date.now() - t0 < 1000);
  await log.waitForNew(99, 20); // times out quietly
});

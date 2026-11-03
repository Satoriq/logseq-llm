import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { dataPaths, defaultConfig, ensureDataDirs, loadConfig, mergeConfig } from '../src/config.ts';
import { runDoctor } from '../src/doctor.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-logseq.mjs', import.meta.url));

test('doctor reports who serves the graph and background CLI workers; samples only warn', async () => {
  const paths = dataPaths(await mkdtemp(join(tmpdir(), 'lsai-doc-')));
  await ensureDataDirs(paths);
  await loadConfig(paths); // writes config.json (0600)
  const config = mergeConfig(defaultConfig(), { graph: 'Sandbox', logseqBin: FAKE, claudeBin: '/nonexistent/claude' });
  const lines: string[] = [];
  await runDoctor({ config, paths, samplePage: '__fail__', out: (l) => lines.push(l) });
  const find = (name: string) => lines.find((l) => l.includes(`${name}:`)) ?? '';
  assert.match(find('graph served by the app'), /^ok /);
  assert.match(find('background CLI workers'), /^warn .*"Main Graph"/);
  assert.match(find('sample show'), /^warn .*simulated failure/);
  assert.match(find('claude binary'), /^FAIL/);
});

test('ednString and userPropertyRefIds', async () => {
  const { ednString, userPropertyRefIds } = await import('../src/doctor.ts');
  assert.equal(ednString('AI "Test"\n'), '"AI \\"Test\\"\\n"');
  const sample = {
    status: 'ok',
    data: [[{ 'db/id': 1, 'user.property/ai-access-x1': { 'db/id': 42 }, 'block/tags': [{ 'db/id': 7 }] }],
      [{ ':db/id': 2, ':user.property/topic-y': [{ ':db/id': 43 }, { ':db/id': 44 }] }]],
  };
  assert.deepEqual(userPropertyRefIds(sample).sort(), [42, 43, 44]);
});

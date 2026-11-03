import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { buildArgv, CliError, LogseqCli } from '../src/tools/cli.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-logseq.mjs', import.meta.url));

test('options are passed as single --key=value elements', () => {
  const argv = buildArgv({ command: ['show'], graph: 'Sandbox', options: { page: 'Home', level: 2 } }, []);
  assert.deepEqual(argv, ['show', '--graph=Sandbox', '--output=json', '--page=Home', '--level=2']);
});

test('option-looking text stays inside the value (no injection)', () => {
  const argv = buildArgv({ command: ['search', 'block'], graph: null, options: { content: '--graph=Other --output=edn' } }, []);
  assert.deepEqual(argv, ['search', 'block', '--output=json', '--content=--graph=Other --output=edn']);
  // Exactly one --graph-like token would be ours; here there is none at all.
  assert.equal(argv.filter((a) => a.startsWith('--graph')).length, 0);
});

test('commands outside the allowlist are refused', () => {
  for (const command of [['graph', 'export'], ['sync', 'start'], ['login'], ['agent'], ['skill', 'install'], ['remove', 'page'], ['server', 'stop']]) {
    assert.throws(() => buildArgv({ command, graph: null }, []), CliError, command.join(' '));
  }
});

test('options outside the per-command allowlist are refused', () => {
  assert.throws(() => buildArgv({ command: ['show'], graph: null, options: { 'root-dir': '/tmp' } }, []), CliError);
  assert.throws(() => buildArgv({ command: ['show'], graph: null, options: { config: '/tmp/x' } }, []), CliError);
  assert.throws(() => buildArgv({ command: ['show'], graph: null, options: { 'Page': 'x' } }, []), CliError);
});

test('write commands need allowWrite and a graph in writeGraphs', () => {
  const req = { command: ['upsert', 'block'], graph: 'Sandbox', options: { content: 'x', 'target-page': 'Inbox' } };
  assert.throws(() => buildArgv(req, ['Sandbox']), /approved write/);
  assert.throws(() => buildArgv({ ...req, allowWrite: true }, []), /writeGraphs/);
  assert.throws(() => buildArgv({ ...req, allowWrite: true, graph: null }, ['Sandbox']), /writeGraphs/);
  const argv = buildArgv({ ...req, allowWrite: true }, ['Sandbox']);
  assert.ok(argv.includes('--content=x'));
});

test('NUL bytes and huge values are refused', () => {
  assert.throws(() => buildArgv({ command: ['show'], graph: null, options: { page: 'a\0b' } }, []), /NUL/);
  assert.throws(() => buildArgv({ command: ['show'], graph: null, options: { page: 'x'.repeat(200_001) } }, []), /too long/);
});

test('runs the binary without a shell and parses JSON output', async () => {
  const cli = new LogseqCli({ bin: FAKE, writeGraphs: [], timeoutMs: 10000, concurrency: 2 });
  const r = await cli.run({ command: ['show'], graph: 'Sandbox', options: { page: 'A "quoted" page; $(rm -rf ~)' } });
  assert.equal(r.ok, true, r.stderr);
  const json = r.json as { argv: string[] };
  assert.ok(json.argv.includes('--page=A "quoted" page; $(rm -rf ~)'));
  assert.ok(json.argv.some((a) => a.startsWith('--timeout-ms=')));
});

test('reports non-zero exit codes and stderr', async () => {
  const cli = new LogseqCli({ bin: FAKE, writeGraphs: [], timeoutMs: 10000, concurrency: 1 });
  const r = await cli.run({ command: ['show'], graph: null, options: { page: '__fail__' } });
  assert.equal(r.ok, false);
  assert.equal(r.exitCode, 3);
  assert.match(r.stderr, /simulated failure/);
});

test('child gets a minimal environment (no secrets inherited)', async () => {
  process.env.ANTHROPIC_API_KEY = 'should-not-leak';
  try {
    const cli = new LogseqCli({ bin: FAKE, writeGraphs: [], timeoutMs: 10000, concurrency: 1 });
    const r = await cli.run({ command: ['show'], graph: null, options: { page: '__env__' } });
    const env = (r.json as { env: string[] }).env;
    assert.ok(!env.includes('ANTHROPIC_API_KEY'));
    for (const k of env) assert.ok(['HOME', 'PATH', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR'].includes(k) || k.startsWith('__CF') , k);
  } finally {
    delete process.env.ANTHROPIC_API_KEY;
  }
});

test('diagnostics allow only fixed read-only commands', async () => {
  const cli = new LogseqCli({ bin: FAKE, writeGraphs: [], timeoutMs: 10000, concurrency: 1 });
  assert.equal((await cli.runDiagnostic(['--version'])).ok, true);
  assert.equal((await cli.runDiagnostic(['show', '--help'])).ok, true);
  assert.throws(() => cli.runDiagnostic(['graph', 'export']), CliError);
  assert.throws(() => cli.runDiagnostic(['sync', 'start', '--help']), CliError);
});

test('relative binary paths are refused', () => {
  assert.throws(() => new LogseqCli({ bin: 'logseq', writeGraphs: [], timeoutMs: 1000, concurrency: 1 }), CliError);
});

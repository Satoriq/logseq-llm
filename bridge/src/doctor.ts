import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { BridgeConfig, DataPaths } from './config.ts';
import { MIN_NODE_MAJOR } from './config.ts';
import { LogseqCli } from './tools/cli.ts';
import type { CliResult } from './tools/cli.ts';
import { PROPERTIES_QUERY } from './graph/reader.ts';

/**
 * Read-only diagnostics. Nothing here writes to a graph or changes a setting.
 * Files written: <data>/doctor/*.txt|json (help texts and, only when asked, samples).
 */

type Check = { name: string; ok: boolean; detail: string; warnOnly?: boolean };

/** Options the bridge passes per CLI command; doctor checks the installed CLI still lists them. */
const CLI_COMMANDS_USED: Record<string, string[]> = {
  show: ['--page', '--uuid', '--id', '--level', '--linked-references'],
  'search block': ['--content'],
  'search page': ['--content'],
  'list task': ['--status', '--limit'],
  'list page': ['--journal-only', '--limit'],
  query: ['--query', '--inputs'],
  'upsert block': ['--target-uuid', '--target-page', '--pos', '--content', '--blocks-file', '--dry-run', '--update-tags'],
  'upsert task': ['--status', '--content', '--target-page'],
  'remove block': ['--uuid'],
};

const SAMPLE_BLOCKS_QUERY =
  '[:find (pull ?b [* {:block/tags [:db/id :db/ident :block/title]} {:block/refs [:db/id :block/title]}]) :in $ ?t :where [?p :block/title ?t] [?b :block/page ?p]]';
// The same property list the reader uses: types, cardinality, public flag, fixed choices.
const SAMPLE_PROPERTIES_QUERY = PROPERTIES_QUERY;
const SAMPLE_VALUES_QUERY =
  '[:find (pull ?e [:db/id :db/ident :block/uuid :block/title :block/name :block/journal-day :logseq.property/value ' +
  '{:logseq.property/created-from-property [:db/id]} {:block/closed-value-property [:db/id :block/title]}]) :in $ [?e ...]]';

/** An EDN string literal. JSON's escapes (\" \\ \n \t \uXXXX) are valid EDN for ordinary text. */
export function ednString(s: string): string {
  return JSON.stringify(s);
}

/** Collects entity ids referenced from user-property attributes anywhere in a CLI JSON result. */
export function userPropertyRefIds(json: unknown): number[] {
  const ids = new Set<number>();
  const idOf = (v: unknown): number | null => {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      const id = o['db/id'] ?? o[':db/id'];
      if (typeof id === 'number' && Number.isInteger(id)) return id;
    }
    return null;
  };
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (v === null || typeof v !== 'object') return;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (/^:?(?:user\.property|plugin\.property\.[^/]+|logseq\.property(?:\.[a-z-]+)?)\//.test(k) || /^:?block\/alias$/.test(k)) {
        for (const item of Array.isArray(val) ? val : [val]) {
          const id = idOf(item);
          if (id !== null) ids.add(id);
          // Small integers may be ids; dates (ms) and other numbers are values.
          else if (typeof item === 'number' && Number.isInteger(item) && item < 1e9) ids.add(item);
        }
      }
      walk(val);
    }
  };
  walk(json);
  return [...ids];
}

const CLAUDE_FLAGS_NEEDED = [
  '--print',
  '--input-format',
  '--output-format',
  '--include-partial-messages',
  '--verbose',
  '--restricted',
  '--tools',
  '--strict-mcp-config',
  '--mcp-config',
  '--allowedTools',
  '--permission-mode',
  '--permission-prompts',
  '--disable-slash-commands',
  '--system-prompt',
  '--model',
  '--effort',
  '--session-id',
  '--resume',
];

function run(bin: string, args: string[], timeoutMs = 20000): Promise<{ ok: boolean; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { shell: false, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (error, stdout, stderr) => {
      resolve({ ok: !error, out: stdout, err: error && typeof error.code !== 'number' ? error.message : stderr });
    });
  });
}

function flagsIn(text: string): Set<string> {
  return new Set(text.match(/--[a-zA-Z][a-zA-Z0-9-]*/g) ?? []);
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    await access(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export type DoctorOptions = {
  config: BridgeConfig;
  paths: DataPaths;
  /** Save `show --page=<title>` JSON output, to learn the CLI's JSON shape. */
  samplePage?: string;
  /** Save `search block --content=<text>` JSON output. */
  sampleSearch?: string;
  out?: (line: string) => void;
};

export async function runDoctor(opts: DoctorOptions): Promise<boolean> {
  const out = opts.out ?? ((l: string) => process.stdout.write(l + '\n'));
  const { config, paths } = opts;
  const checks: Check[] = [];
  const add = (c: Check): void => {
    checks.push(c);
    out(`${c.ok ? 'ok  ' : c.warnOnly ? 'warn' : 'FAIL'}  ${c.name}: ${c.detail}`);
  };

  // Node
  const major = Number(process.versions.node.split('.')[0]);
  add({ name: 'node', ok: major >= MIN_NODE_MAJOR, detail: `v${process.versions.node} (need >= ${MIN_NODE_MAJOR}) at ${process.execPath}` });

  // Data dir permissions
  const st = await stat(paths.root);
  add({ name: 'data dir', ok: (st.mode & 0o077) === 0, detail: `${paths.root} mode ${(st.mode & 0o777).toString(8)} (want 700)` });
  try {
    const cst = await stat(paths.config);
    // Others must not be able to change the config (it holds the allow/deny lists).
    add({ name: 'config.json', ok: (cst.mode & 0o022) === 0, detail: `${paths.config} mode ${(cst.mode & 0o777).toString(8)} (want 600; run: chmod 600 on it)` });
  } catch {
    add({ name: 'config.json', ok: false, detail: `missing: ${paths.config}` });
  }

  // logseq CLI
  const logseqOk = await isExecutable(config.logseqBin);
  add({ name: 'logseq binary', ok: logseqOk, detail: config.logseqBin });
  if (logseqOk) {
    const cli = new LogseqCli({ bin: config.logseqBin, writeGraphs: [], timeoutMs: config.cliTimeoutMs, concurrency: 1 });
    const version = await cli.runDiagnostic(['--version']);
    add({ name: 'logseq --version', ok: version.ok, detail: (version.stdout || version.stderr).trim().split('\n')[0] ?? '' });

    const graphs = await cli.runDiagnostic(['graph', 'list']);
    add({ name: 'logseq graph list', ok: graphs.ok, detail: graphs.ok ? `${graphs.stdout.trim().split('\n').length} line(s) of output` : graphs.stderr.trim() });
    if (graphs.ok && config.graph !== null) {
      add({ name: 'configured graph', ok: graphs.stdout.includes(config.graph), detail: config.graph, warnOnly: true });
    } else if (config.graph === null) {
      add({ name: 'configured graph', ok: false, warnOnly: true, detail: 'graph is null in config.json, so tools use the CLI\'s current graph. Set it to your sandbox graph for testing.' });
    }

    // Which process serves each graph. If the app doesn't have a graph open, the CLI starts
    // its own background worker for it ("owner-source: cli") and leaves it running.
    const servers = await cli.runDiagnostic(['server', 'list', '--output=json']);
    const list = ((servers.json as { data?: { servers?: unknown } } | null)?.data?.servers ?? null) as
      | { graph?: unknown; 'owner-source'?: unknown }[]
      | null;
    if (Array.isArray(list)) {
      const cliOwned = list.filter((s) => s['owner-source'] === 'cli').map((s) => String(s.graph));
      const mine = list.find((s) => s.graph === config.graph);
      if (config.graph !== null) {
        add({
          name: 'graph served by the app',
          ok: mine !== undefined && mine['owner-source'] === 'electron',
          warnOnly: true,
          detail:
            mine === undefined
              ? `no worker for "${config.graph}" yet (open it in Logseq)`
              : `"${config.graph}" is served by ${String(mine['owner-source'])}${mine['owner-source'] === 'electron' ? '' : ' (open it in Logseq so edits in the app and the CLI share one worker)'}`,
        });
      }
      add({
        name: 'background CLI workers',
        ok: cliOwned.length === 0,
        warnOnly: true,
        detail:
          cliOwned.length === 0
            ? 'none'
            : `running for: ${cliOwned.map((g) => JSON.stringify(g)).join(', ')} (started by the CLI because the app did not have that graph open; stop with: logseq server stop --graph="<name>")`,
      });
    } else {
      add({ name: 'server list', ok: false, warnOnly: true, detail: 'could not read `logseq server list --output=json`' });
    }

    // Writes (step 3): the graph must be listed in writeGraphs, and the AI-GENERATED tag must exist.
    if (config.graph !== null) {
      const canWrite = config.writeGraphs.includes(config.graph);
      add({
        name: 'writes',
        ok: canWrite,
        warnOnly: true,
        detail: canWrite
          ? `allowed for "${config.graph}" (each write still needs Apply in the panel)`
          : `off for "${config.graph}" (add it to "writeGraphs" in config.json to allow approved writes)`,
      });
      const tag = await cli.run({ command: ['search', 'tag'], graph: config.graph, options: { content: config.aiTag } });
      const items = ((tag.json as { data?: { items?: unknown } } | null)?.data?.items ?? []) as { 'block/title'?: unknown; title?: unknown }[];
      const hasTag = tag.ok && Array.isArray(items) && items.some((i) => String(i['block/title'] ?? i.title ?? '').toLowerCase() === config.aiTag.toLowerCase());
      add({
        name: `#${config.aiTag} tag`,
        ok: hasTag || canWrite,
        warnOnly: true,
        detail: hasTag ? 'exists' : canWrite ? 'not there yet; the bridge creates it with the first write' : 'missing (writes are off anyway)',
      });
    }

    const helpParts: string[] = [];
    const top = await cli.runDiagnostic(['--help']);
    helpParts.push(`=== logseq --help\n${top.stdout}${top.stderr}`);
    for (const [command, needed] of Object.entries(CLI_COMMANDS_USED)) {
      const args = [...command.split(' '), '--help'];
      const help = await cli.runDiagnostic(args);
      const text = `${help.stdout}${help.stderr}`;
      helpParts.push(`=== logseq ${command} --help\n${text}`);
      const listed = flagsIn(text);
      const missing = needed.filter((f) => !listed.has(f));
      add({
        name: `logseq ${command} options`,
        ok: help.ok && missing.length === 0,
        warnOnly: true,
        detail: !help.ok ? 'help failed' : missing.length === 0 ? 'all expected options listed' : `not listed: ${missing.join(', ')}`,
      });
    }
    const helpFile = join(paths.doctor, 'logseq-cli-help.txt');
    await writeFile(helpFile, helpParts.join('\n\n'), { mode: 0o600 });
    out(`      saved CLI help to ${helpFile}`);

    const graphLabel = config.graph === null ? "the CLI's current graph" : `graph "${config.graph}"`;
    const sample = async (name: string, file: string, req: Parameters<LogseqCli['run']>[0]): Promise<CliResult> => {
      const r = await cli.run(req);
      const f = join(paths.doctor, file);
      await writeFile(f, r.stdout || r.stderr, { mode: 0o600 });
      const reason = (r.stderr.trim() || r.stdout.trim()).split('\n')[0]?.slice(0, 200) ?? '';
      add({
        name,
        ok: r.ok,
        // A missing sample page is not a health problem, so this never fails doctor.
        warnOnly: true,
        detail: r.ok
          ? `${f} from ${graphLabel} (contains note text: share only if harmless)`
          : `exit ${r.exitCode} on ${graphLabel}: ${reason} (output saved to ${f})`,
      });
      return r;
    };
    if (opts.samplePage !== undefined) {
      const graph = config.graph;
      await sample('sample show', 'sample-show.json', { command: ['show'], graph, options: { page: opts.samplePage, level: 2 } });
      // `show` doesn't include user properties, so also pull the raw block entities. Step 1b reads
      // tags and properties this way for the privacy filter. The title goes in --inputs, never into the query text.
      const blocks = await sample('sample query blocks', 'sample-query-blocks.json', {
        command: ['query'],
        graph,
        options: { query: SAMPLE_BLOCKS_QUERY, inputs: `[${ednString(opts.samplePage)}]` },
      });
      await sample('sample query properties', 'sample-query-properties.json', { command: ['query'], graph, options: { query: SAMPLE_PROPERTIES_QUERY } });
      const ids = userPropertyRefIds(blocks.json).slice(0, 200);
      if (ids.length > 0) {
        await sample('sample query values', 'sample-query-values.json', {
          command: ['query'],
          graph,
          options: { query: SAMPLE_VALUES_QUERY, inputs: `[[${ids.join(' ')}]]` },
        });
      }
    }
    if (opts.sampleSearch !== undefined) {
      await sample('sample search', 'sample-search.json', { command: ['search', 'block'], graph: config.graph, options: { content: opts.sampleSearch } });
    }
  }

  // claude CLI
  const claudeOk = await isExecutable(config.claudeBin);
  add({ name: 'claude binary', ok: claudeOk, detail: config.claudeBin });
  if (claudeOk) {
    const v = await run(config.claudeBin, ['--version']);
    add({ name: 'claude --version', ok: v.ok, detail: (v.out || v.err).trim() });
    const h = await run(config.claudeBin, ['--help']);
    const listed = flagsIn(h.out);
    const missing = CLAUDE_FLAGS_NEEDED.filter((f) => !listed.has(f));
    add({ name: 'claude flags', ok: h.ok && missing.length === 0, detail: missing.length === 0 ? 'all needed flags listed' : `not listed: ${missing.join(', ')}` });
  }

  const failed = checks.filter((c) => !c.ok && !c.warnOnly).length;
  const warned = checks.filter((c) => !c.ok && c.warnOnly).length;
  out(`\n${failed === 0 ? 'doctor: OK' : `doctor: ${failed} failed`}${warned ? `, ${warned} warning(s)` : ''}`);
  return failed === 0;
}

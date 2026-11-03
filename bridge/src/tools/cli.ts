import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';

/**
 * The ONLY code in the bridge that runs the `logseq` CLI.
 *
 * Safety rules:
 * - execFile with an argument array, never a shell.
 * - Only allowlisted subcommands, and per-subcommand allowlisted options
 *   (mirrors cli/lib/cli_parse.ml in Logseq's source).
 * - Every option is passed as ONE argv element `--key=value`. The CLI treats
 *   `--key value` where value starts with "-" as a new option, so model text
 *   such as "--graph=Other" could otherwise inject an option. With `--key=value`
 *   everything after the first "=" is the value.
 * - No positional arguments are ever passed.
 * - Write subcommands need an explicit `allowWrite` from the write path (step 3)
 *   and a graph listed in `writeGraphs`.
 */

export type CliValue = string | number | boolean;

export type CliRequest = {
  /** e.g. ['show'], ['search', 'block'], ['list', 'task']. */
  command: readonly string[];
  options?: Record<string, CliValue | undefined>;
  /** Graph name; null = the CLI's current graph. */
  graph: string | null;
  /** Must be true for upsert/remove (set only by the approved-write path). */
  allowWrite?: boolean;
  timeoutMs?: number;
};

export type CliResult = {
  ok: boolean;
  exitCode: number;
  /** Parsed JSON stdout when it parsed, else null. */
  json: unknown;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export class CliError extends Error {}

const READ_COMMANDS: Record<string, readonly string[]> = {
  'list page': ['fields', 'limit', 'offset', 'sort', 'order', 'expand', 'include-built-in', 'include-journal', 'journal-only', 'include-hidden', 'updated-after', 'created-after'],
  'list tag': ['fields', 'limit', 'offset', 'sort', 'order', 'expand', 'include-built-in', 'with-properties', 'with-extends'],
  'list property': ['fields', 'limit', 'offset', 'sort', 'order', 'expand', 'include-built-in', 'with-classes', 'with-type'],
  'list task': ['fields', 'limit', 'offset', 'sort', 'order', 'status', 'priority', 'content'],
  'list node': ['fields', 'limit', 'offset', 'sort', 'order', 'tags', 'properties'],
  'search block': ['content', 'include-hidden'],
  'search page': ['content', 'include-hidden'],
  'search property': ['content', 'include-hidden'],
  'search tag': ['content', 'include-hidden'],
  show: ['id', 'uuid', 'page', 'page-hierarchy', 'linked-references', 'ref-id-footer', 'level'],
  query: ['query', 'name', 'inputs'],
  'query list': [],
};

const WRITE_COMMANDS: Record<string, readonly string[]> = {
  'upsert block': ['id', 'uuid', 'target-id', 'target-uuid', 'target-page', 'pos', 'content', 'blocks', 'blocks-file', 'dry-run', 'update-tags', 'update-properties', 'remove-tags', 'remove-properties'],
  'upsert page': ['id', 'page', 'update-tags', 'update-properties', 'remove-tags', 'remove-properties'],
  'upsert task': ['id', 'uuid', 'page', 'content', 'target-id', 'target-uuid', 'target-page', 'pos', 'status', 'priority', 'scheduled', 'deadline', 'no-status', 'no-priority', 'no-scheduled', 'no-deadline'],
  'upsert tag': ['id', 'name', 'add-properties', 'remove-properties'],
  'remove block': ['id', 'uuid'],
};

/** Read-only commands `doctor` may run. Never graph/server/sync/login/agent/skill install. */
const DOCTOR_COMMANDS = new Set(['--version', 'graph list', 'server list']);

const OPTION_KEY_RE = /^[a-z][a-z0-9-]{0,40}$/;
const MAX_VALUE_LENGTH = 200_000;

export function isWriteCommand(command: readonly string[]): boolean {
  return Object.hasOwn(WRITE_COMMANDS, command.join(' '));
}

function allowedOptions(command: readonly string[]): readonly string[] | null {
  const key = command.join(' ');
  if (Object.hasOwn(READ_COMMANDS, key)) return READ_COMMANDS[key] ?? null;
  if (Object.hasOwn(WRITE_COMMANDS, key)) return WRITE_COMMANDS[key] ?? null;
  return null;
}

function checkValue(key: string, value: string): void {
  if (value.length > MAX_VALUE_LENGTH) throw new CliError(`option --${key} is too long`);
  if (value.includes('\0')) throw new CliError(`option --${key} contains a NUL byte`);
}

/**
 * Builds the argv for a request. Exported for tests.
 * Global options come first, then the subcommand, then its options, all as --key=value.
 */
export function buildArgv(req: CliRequest, writeGraphs: readonly string[]): string[] {
  const allowed = allowedOptions(req.command);
  if (!allowed) throw new CliError(`logseq ${req.command.join(' ')} is not an allowed command`);
  if (isWriteCommand(req.command)) {
    if (req.allowWrite !== true) throw new CliError('write commands need an approved write');
    if (req.graph === null || !writeGraphs.includes(req.graph)) {
      throw new CliError(`graph ${JSON.stringify(req.graph)} is not in writeGraphs`);
    }
  }
  const argv: string[] = [...req.command];
  if (req.graph !== null) {
    checkValue('graph', req.graph);
    argv.push(`--graph=${req.graph}`);
  }
  argv.push('--output=json');
  for (const [key, value] of Object.entries(req.options ?? {})) {
    if (value === undefined) continue;
    if (!OPTION_KEY_RE.test(key) || !allowed.includes(key)) {
      throw new CliError(`option --${key} is not allowed for logseq ${req.command.join(' ')}`);
    }
    const text = typeof value === 'string' ? value : String(value);
    checkValue(key, text);
    argv.push(`--${key}=${text}`);
  }
  return argv;
}

function minimalEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const k of ['HOME', 'PATH', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR']) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  return env;
}

/** Small semaphore so the CLI (an Electron-as-Node process) never runs many copies at once. */
class Limiter {
  #max: number;
  #running = 0;
  #queue: (() => void)[] = [];

  constructor(max: number) {
    this.#max = Math.max(1, max);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#running >= this.#max) {
      await new Promise<void>((resolve) => this.#queue.push(resolve));
    }
    this.#running += 1;
    try {
      return await fn();
    } finally {
      this.#running -= 1;
      this.#queue.shift()?.();
    }
  }
}

export type LogseqCliOptions = {
  bin: string;
  writeGraphs: readonly string[];
  timeoutMs: number;
  concurrency: number;
};

export class LogseqCli {
  readonly bin: string;
  #writeGraphs: readonly string[];
  #timeoutMs: number;
  #limiter: Limiter;

  constructor(opts: LogseqCliOptions) {
    if (!isAbsolute(opts.bin)) throw new CliError('logseqBin must be an absolute path');
    this.bin = opts.bin;
    this.#writeGraphs = opts.writeGraphs;
    this.#timeoutMs = opts.timeoutMs;
    this.#limiter = new Limiter(opts.concurrency);
  }

  run(req: CliRequest): Promise<CliResult> {
    const argv = buildArgv(req, this.#writeGraphs);
    // The CLI's own --timeout-ms goes first, a little shorter than our kill timer.
    const timeout = req.timeoutMs ?? this.#timeoutMs;
    argv.splice(req.command.length, 0, `--timeout-ms=${Math.max(1000, timeout - 1000)}`);
    return this.#limiter.run(() => this.#exec(argv, timeout));
  }

  /** For `doctor` only: a few fixed read-only commands and `--help` of allowed commands. */
  runDiagnostic(args: readonly string[]): Promise<CliResult> {
    const joined = args.join(' ');
    const isHelp = args.length >= 2 && args[args.length - 1] === '--help' && allowedOptions(args.slice(0, -1)) !== null;
    const isTopHelp = joined === '--help';
    if (!DOCTOR_COMMANDS.has(joined) && !isHelp && !isTopHelp) {
      throw new CliError(`diagnostic command not allowed: ${joined}`);
    }
    return this.#limiter.run(() => this.#exec([...args], this.#timeoutMs));
  }

  #exec(argv: string[], timeoutMs: number): Promise<CliResult> {
    const started = Date.now();
    return new Promise((resolve) => {
      execFile(
        this.bin,
        argv,
        { shell: false, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: minimalEnv(), encoding: 'utf8' },
        (error, stdout, stderr) => {
          const exitCode = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
          if (error && typeof error.code !== 'number') {
            // Spawn failure (e.g. ENOENT) or killed by the timeout.
            stderr = `${error.killed ? `timed out after ${timeoutMs} ms` : error.message}\n${stderr}`;
          }
          let json: unknown = null;
          const trimmed = stdout.trim();
          if (trimmed !== '') {
            try {
              json = JSON.parse(trimmed);
            } catch {
              json = null;
            }
          }
          resolve({
            ok: exitCode === 0,
            exitCode,
            json,
            stdout,
            stderr: stderr.slice(0, 8000),
            durationMs: Date.now() - started,
          });
        },
      );
    });
  }
}

/**
 * Minimal stderr logger. Never pass note content, prompts, model output or tokens here:
 * log what happened (method, path, status, ids, counts), not what was said.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  const env = (process.env.LOGSEQ_AI_LOG_LEVEL ?? 'info') as Level;
  return ORDER[env] ?? ORDER.info;
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < threshold()) return;
  const line = fields ? `${msg} ${JSON.stringify(fields)}` : msg;
  process.stderr.write(`${new Date().toISOString()} ${level.toUpperCase()} ${line}\n`);
}

export const log = {
  debug: (msg: string, fields?: Record<string, unknown>) => emit('debug', msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => emit('info', msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit('warn', msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit('error', msg, fields),
};

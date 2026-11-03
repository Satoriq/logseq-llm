import { messageText } from '../chats/store.ts';
import type { ModelInfo, Provider, TurnRequest, TurnResult } from './types.ts';

/**
 * Test provider: streams the last user message back word by word. No network,
 * no graph access. Lets you test the server, SSE and (later) the panel without
 * spending any model usage.
 */
export class EchoProvider implements Provider {
  readonly id = 'echo';
  readonly label = 'Echo (test)';
  readonly locality = 'local' as const;
  readonly delayMs: number;

  constructor(delayMs = 40) {
    this.delayMs = delayMs;
  }

  async models(): Promise<ModelInfo[]> {
    return [{ id: 'echo', label: 'Echo', efforts: ['auto'] }];
  }

  async runTurn(req: TurnRequest): Promise<TurnResult> {
    const last = [...req.messages].reverse().find((m) => m.role === 'user');
    const text = last ? messageText(last) : '';
    const words = `You said: ${text}`.split(/(\s+)/).filter((w) => w !== '');
    for (const w of words) {
      if (req.signal.aborted) return { stopReason: 'cancelled' };
      req.emit({ type: 'text.delta', text: w });
      await sleep(this.delayMs, req.signal);
    }
    if (req.signal.aborted) return { stopReason: 'cancelled' };
    return { stopReason: 'end', usage: { outputWords: words.length } };
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

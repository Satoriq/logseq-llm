import { openStream, parseArgs, sseEvents } from './stream.ts';
import type { Wire, WireCall, WireOptions, WireResult, WireSession, WireStep } from './stream.ts';

/**
 * The Responses API (OpenAI, xAI). OpenAI's current models need it for tool calling.
 * store: false keeps notes off the provider's servers, so the bridge carries the conversation:
 * each step's output items, reasoning included, go back unchanged in the next request.
 */

export const responsesWire: Wire = (o: WireOptions): WireSession => {
  const input: unknown[] = o.messages.map((m) => ({ role: m.role, content: m.text }));
  const tools = o.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.inputSchema }));
  const level = o.effort === 'off' ? 'none' : o.effort;

  return {
    async step(on): Promise<WireStep> {
      const res = await openStream(o, { authorization: `Bearer ${o.key}` }, {
        model: o.model,
        instructions: o.system,
        input,
        tools,
        stream: true,
        store: false,
        ...(o.sendEffort && o.effort !== 'auto' ? { reasoning: { effort: level } } : {}),
      });

      let done: Record<string, any> | null = null;
      let incomplete = false;
      for await (const e of sseEvents(res)) {
        if (e.type === 'response.output_text.delta') on.text(String(e.delta ?? ''));
        else if (e.type === 'response.reasoning_summary_text.delta') on.thinking(String(e.delta ?? ''));
        else if (e.type === 'response.completed') done = e.response;
        else if (e.type === 'response.incomplete') {
          done = e.response;
          incomplete = true;
        } else if (e.type === 'response.failed' || e.type === 'error') {
          const message = e.response?.error?.message ?? e.error?.message ?? e.message ?? 'the reply failed';
          throw new Error(`${o.label}: ${String(message).slice(0, 300)}`);
        }
      }
      if (!done) throw new Error(`${o.label}: the reply ended early.`);

      const output = (done.output ?? []) as Record<string, any>[];
      input.push(...output);
      const calls: WireCall[] = output.filter((i) => i.type === 'function_call').map((i) => ({ id: i.call_id, name: i.name, args: parseArgs(String(i.arguments ?? '')) }));
      return {
        calls: incomplete ? [] : calls,
        stop: incomplete ? 'length' : 'end',
        inputTokens: done.usage?.input_tokens ?? 0,
        outputTokens: done.usage?.output_tokens ?? 0,
      };
    },

    addResults(results: WireResult[]): void {
      for (const r of results) input.push({ type: 'function_call_output', call_id: r.id, output: r.isError ? `Error: ${r.text}` : r.text });
    },
  };
};

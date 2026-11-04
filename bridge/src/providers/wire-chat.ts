import { openStream, parseArgs, sseEvents } from './stream.ts';
import type { Wire, WireCall, WireOptions, WireResult, WireSession, WireStep } from './stream.ts';

/**
 * Chat Completions, which Gemini, DeepSeek, Mistral and OpenRouter speak. A tool call arrives in
 * pieces and is put together by its index. Whatever else a provider attaches to a call or a
 * message goes back with it, such as Gemini's thought signature in extra_content.
 */

type Call = { id: string; type: 'function'; function: { name: string; arguments: string } } & Record<string, unknown>;

export const chatWire: Wire = (o: WireOptions): WireSession => {
  const messages: unknown[] = [{ role: 'system', content: o.system }, ...o.messages.map((m) => ({ role: m.role, content: m.text }))];
  const tools = o.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));

  return {
    async step(on): Promise<WireStep> {
      const res = await openStream(o, { authorization: `Bearer ${o.key}` }, {
        model: o.model,
        messages,
        ...(tools.length > 0 ? { tools } : {}),
        stream: true,
        stream_options: { include_usage: true },
        ...(o.sendEffort && o.effort !== 'auto' ? { reasoning_effort: o.effort === 'off' ? 'none' : o.effort } : {}),
        ...o.extraBody,
      });

      let content = '';
      let reasoning = '';
      let finish = '';
      let inputTokens = 0;
      let outputTokens = 0;
      const parts: Call[] = [];
      for await (const e of sseEvents(res)) {
        if (e.error) throw new Error(`${o.label}: ${String(e.error.message ?? 'the reply failed').slice(0, 300)}`);
        if (e.usage) {
          inputTokens = e.usage.prompt_tokens ?? inputTokens;
          outputTokens = e.usage.completion_tokens ?? outputTokens;
        }
        const choice = e.choices?.[0];
        if (!choice) continue;
        const d = choice.delta ?? {};
        if (d.content) {
          content += d.content;
          on.text(d.content);
        }
        if (d.reasoning_content) {
          reasoning += d.reasoning_content;
          on.thinking(d.reasoning_content);
        }
        for (const tc of d.tool_calls ?? []) {
          const i = typeof tc.index === 'number' ? tc.index : parts.length;
          const { index: _index, function: fn, ...rest } = tc;
          const slot = (parts[i] ??= { id: '', type: 'function', function: { name: '', arguments: '' } });
          Object.assign(slot, rest);
          if (fn?.name) slot.function.name = fn.name;
          if (fn?.arguments) slot.function.arguments += typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments);
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
      if (finish === '') throw new Error(`${o.label}: the reply ended early.`);

      const toolCalls = parts.filter(Boolean).map((c, i) => ({ ...c, id: c.id || `call_${i}` }));
      messages.push({
        role: 'assistant',
        content,
        ...(reasoning ? { reasoning_content: reasoning } : {}),
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      });
      const cut = finish === 'length';
      const blocked = finish === 'content_filter';
      const calls: WireCall[] = cut || blocked ? [] : toolCalls.map((c) => ({ id: c.id, name: c.function.name, args: parseArgs(c.function.arguments) }));
      const step: WireStep = { calls, stop: blocked ? 'refusal' : cut ? 'length' : 'end', inputTokens, outputTokens };
      if (blocked) step.notice = `${o.label} blocked this reply with its content filter.`;
      return step;
    },

    addResults(results: WireResult[]): void {
      for (const r of results) {
        messages.push({ role: 'tool', tool_call_id: r.id, content: r.isError ? `Error: ${r.text}` : r.text, ...(o.namedResults ? { name: r.name } : {}) });
      }
    },
  };
};

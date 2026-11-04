import { openStream, parseArgs, sseEvents } from './stream.ts';
import type { Wire, WireCall, WireOptions, WireResult, WireSession, WireStep } from './stream.ts';

/**
 * Anthropic's Messages API. Blocks from a step go back unchanged in the next request of the same
 * turn: thinking blocks carry a signature, and tool calls need the thinking that led to them.
 */

const VERSION = '2026-10-21';
const MAX_TOKENS = 64_000;
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** If a safety check declines a request, these models let another Claude model take over. */
const HAS_FALLBACK = /^claude-(opus|sonnet|fable)-/;

type Block = Record<string, any> & { type: string };

/** Off isn't "off" on every model. Models with no way to turn thinking off don't offer it. */
function thinkingFor(o: WireOptions): Record<string, unknown> {
  if (o.effort !== 'off') return { type: 'adaptive', display: 'summarized' };
  return o.model.includes('sonnet') ? { type: 'between_tools' } : { type: 'disabled' };
}

/** After a fallback, what the declined model did before it doesn't go back, and doesn't run. */
function afterFallback(blocks: Block[]): Block[] {
  const last = blocks.findLastIndex((b) => b.type === 'fallback');
  if (last === -1) return blocks;
  const keepBefore = blocks.slice(0, last).filter((b) => b.type === 'text');
  return [...keepBefore, ...blocks.slice(last + 1)];
}

export const anthropicWire: Wire = (o: WireOptions): WireSession => {
  const messages: unknown[] = o.messages.map((m) => ({ role: m.role, content: m.text }));
  const tools = o.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  const fallback = HAS_FALLBACK.test(o.model) && o.effort !== 'off';

  return {
    async step(on): Promise<WireStep> {
      const res = await openStream(
        o,
        { 'x-api-key': o.key, 'anthropic-version': VERSION, ...(fallback ? { 'anthropic-beta': FALLBACK_BETA } : {}) },
        {
          model: o.model,
          max_tokens: MAX_TOKENS,
          stream: true,
          system: o.system,
          messages,
          tools,
          // Caches the prompt, tools and earlier steps, so each round of a tool loop costs far less.
          cache_control: { type: 'ephemeral' },
          thinking: thinkingFor(o),
          ...(o.effort === 'auto' || o.effort === 'off' ? {} : { output_config: { effort: o.effort } }),
          ...(fallback ? { fallbacks: 'default' } : {}),
        },
      );

      const blocks: Block[] = [];
      const inputs = new Map<Block, string>();
      let stopReason = '';
      let category: unknown = null;
      let inputTokens = 0;
      let outputTokens = 0;
      for await (const e of sseEvents(res)) {
        const current = blocks.at(-1);
        if (e.type === 'error') throw new Error(`${o.label}: ${String(e.error?.message ?? 'stream error').slice(0, 300)}`);
        if (e.type === 'message_start') {
          const u = e.message?.usage ?? {};
          inputTokens += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        } else if (e.type === 'content_block_start') {
          blocks.push({ ...e.content_block });
          if (e.content_block.type === 'tool_use') inputs.set(blocks.at(-1) as Block, '');
        } else if (e.type === 'content_block_delta' && current) {
          const d = e.delta;
          if (d.type === 'text_delta') {
            current.text = `${current.text ?? ''}${d.text}`;
            on.text(d.text);
          } else if (d.type === 'thinking_delta') {
            current.thinking = `${current.thinking ?? ''}${d.thinking}`;
            on.thinking(d.thinking);
          } else if (d.type === 'signature_delta') {
            current.signature = d.signature;
          } else if (d.type === 'input_json_delta') {
            inputs.set(current, `${inputs.get(current) ?? ''}${d.partial_json}`);
          }
        } else if (e.type === 'message_delta') {
          stopReason = e.delta?.stop_reason ?? stopReason;
          category = e.delta?.stop_details?.category ?? category;
          outputTokens += e.usage?.output_tokens ?? 0;
        }
      }
      if (stopReason === '') throw new Error(`${o.label}: the reply ended early.`);

      const kept = afterFallback(blocks).filter((b) => b.type !== 'fallback' && !(b.type === 'text' && !b.text));
      const calls: WireCall[] = [];
      for (const b of kept) {
        if (b.type !== 'tool_use') continue;
        const args = parseArgs(inputs.get(b) ?? '');
        // A tool_use block has to go back with an object, even when the model's JSON was broken.
        b.input = args !== null && typeof args === 'object' ? args : {};
        calls.push({ id: b.id, name: b.name, args });
      }
      messages.push({ role: 'assistant', content: kept });

      const declined = stopReason === 'refusal';
      const step: WireStep = { calls: declined ? [] : calls, stop: declined ? 'refusal' : stopReason === 'max_tokens' ? 'length' : 'end', inputTokens, outputTokens };
      if (declined) step.notice = `Claude declined this request${category ? ` (${String(category)})` : ''}.`;
      else if (blocks.some((b) => b.type === 'fallback')) step.notice = 'A safety check declined this on the model you picked, so another Claude model answered.';
      return step;
    },

    addResults(results: WireResult[]): void {
      // All results of a step go back in one message.
      messages.push({
        role: 'user',
        content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.text, ...(r.isError ? { is_error: true } : {}) })),
      });
    },
  };
};

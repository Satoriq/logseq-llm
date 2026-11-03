#!/usr/bin/env node
// Test stand-in for `claude -p`: records its argv/env/prompt, speaks stream-json, and (on request)
// calls the bridge's MCP endpoint like the real CLI would. Behaviour is selected by markers in the prompt.
import { readFileSync, writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const get = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const prompt = readFileSync(0, 'utf8');
const mcp = JSON.parse(readFileSync(get('--mcp-config'), 'utf8')).mcpServers.lsq;
writeFileSync('fake-claude-argv.json', JSON.stringify(argv));
writeFileSync('fake-claude-env.json', JSON.stringify(Object.keys(process.env)));
writeFileSync('fake-claude-prompt.txt', prompt);
writeFileSync('fake-claude-mcp.json', JSON.stringify(mcp));

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
const session = get('--session-id') ?? get('--resume');
const allowed = (get('--allowedTools') ?? '').split(',').filter(Boolean);
out({
  type: 'system',
  subtype: 'init',
  session_id: session,
  tools: prompt.includes('FAKE:badtool') ? [...allowed, 'Bash'] : allowed,
  mcp_servers: [{ name: 'lsq', status: 'connected' }],
  apiKeySource: prompt.includes('FAKE:apikey') ? 'ANTHROPIC_API_KEY' : 'none',
  model: get('--model'),
});
if (prompt.includes('FAKE:badtool') || prompt.includes('FAKE:hang')) {
  await new Promise((r) => setTimeout(r, 10_000)); // the bridge must kill us before this
}
let text = `Hello from fake claude (${argv.includes('--resume') ? 'resumed' : 'new'}).`;
if (prompt.includes('FAKE:tool')) {
  const rpc = async (method, params, id) => {
    const r = await fetch(mcp.url, {
      method: 'POST',
      headers: { ...mcp.headers, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', ...(id !== undefined ? { id } : {}), method, params }),
    });
    return r.status === 202 ? null : r.json();
  };
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake', version: '0' } }, 1);
  await rpc('notifications/initialized', {});
  const list = await rpc('tools/list', {}, 2);
  const call = await rpc('tools/call', { name: 'get_page', arguments: { title: 'AI Test' } }, 3);
  text += ` tools=${list.result.tools.length} page=${JSON.stringify(call.result.content[0].text)}`;
}
if (prompt.includes('FAKE:write')) {
  // Like a real model: propose a write and report what the tool answered (Applied / rejected).
  const r = await fetch(mcp.url, {
    method: 'POST',
    headers: { ...mcp.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'insert_blocks', arguments: { page: 'AI Test', markdown: '- Written by AI\n  - with a child' } } }),
  });
  const j = await r.json();
  text += ` write=${JSON.stringify(j.result.content[0].text)}`;
}
const call = async (name, args, id) => {
  const r = await fetch(mcp.url, {
    method: 'POST',
    headers: { ...mcp.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }),
  });
  return (await r.json()).result.content[0].text;
};
if (prompt.includes('FAKE:twowrites')) {
  text += ` first=${JSON.stringify(await call('insert_blocks', { page: 'AI Test', markdown: '- first change' }, 21))}`;
  text += ` second=${JSON.stringify(await call('insert_blocks', { page: 'AI Test', markdown: '- second change' }, 22))}`;
}
if (prompt.includes('FAKE:addedit')) {
  text += ` add=${JSON.stringify(await call('insert_blocks', { page: 'AI Test', markdown: '- an addition' }, 31))}`;
  const edits = ['a558ac4e-ae05-43f3-af22-f167c5f56975', '54f76cdd-307a-436e-9716-f129841c97e6', '05c4b96b-5012-4826-a902-693efb290e0d'].map((uuid, i) => ({ uuid, content: `edited ${i}` }));
  text += ` edit=${JSON.stringify(await call('update_blocks', { edits }, 32))}`;
}
if (prompt.includes('FAKE:error')) {
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom', session_id: session });
  process.exit(1);
}
for (const piece of text.match(/[\s\S]{1,20}/g)) {
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: piece } } });
}
out({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: session, usage: { input_tokens: 10, output_tokens: 5 } });

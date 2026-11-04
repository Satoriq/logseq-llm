import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AuditLog } from '../src/audit.ts';
import { ChatStore, messageText } from '../src/chats/store.ts';
import type { Locality } from '../src/chats/store.ts';
import { TurnError, TurnRunner } from '../src/chats/turns.ts';
import type { Provider, TurnRequest } from '../src/providers/types.ts';

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'lsai-share-'));
  const store = new ChatStore(dir);
  const audit = join(dir, 'audit.jsonl');
  const seen = new Map<string, string[]>();
  const shared: string[] = [];
  let release: (() => void) | null = null;
  const fake = (id: string, locality: Locality): Provider => ({
    id,
    label: id,
    locality,
    models: async () => [{ id: 'm', label: 'm', efforts: ['auto'] }],
    onShared: async (chatId) => void shared.push(`${id}:${chatId}`),
    runTurn: async (req: TurnRequest) => {
      seen.set(id, req.messages.map(messageText));
      if (messageText(req.messages.at(-1) as never) === 'hold') await new Promise<void>((r) => (release = r));
      req.emit({ type: 'text.delta', text: `from ${id}` });
      return { stopReason: 'end' };
    },
  });
  const turns = new TurnRunner({ store, providers: [fake('claude', 'cloud'), fake('gpt', 'cloud'), fake('ollama', 'local')], audit: new AuditLog(audit), epoch: 'e' });
  const chat = await store.create('t');
  const say = async (text: string, providerId: string): Promise<void> => {
    await (await turns.start(chat.id, { text, providerId, model: 'm', effort: 'auto', contextUuids: [] })).done;
  };
  return { turns, chat, say, seen, shared, audit, store, release: () => release?.() };
}

test('switching to a cloud model asks, and says the text came from a local one', async () => {
  const { turns, chat, say } = await setup();
  await say('private question', 'ollama');
  assert.deepEqual(await turns.shareState(chat.id, 'claude'), { ask: true, unseen: 2, local: true });
});

test('nothing is asked for a local model, or for a model that has seen it all', async () => {
  const { turns, chat, say } = await setup();
  await say('one', 'claude');
  assert.equal((await turns.shareState(chat.id, 'ollama')).ask, false, 'it stays on this Mac');
  assert.equal((await turns.shareState(chat.id, 'claude')).ask, false);
});

test('two cloud models are two companies: one sees the other only if you say so', async () => {
  const { turns, chat, say, seen } = await setup();
  await say('for claude', 'claude');
  assert.deepEqual(await turns.shareState(chat.id, 'gpt'), { ask: true, unseen: 2, local: false });
  await say('for gpt', 'gpt');
  assert.deepEqual(seen.get('gpt'), ['for gpt']);
});

test('yes: the provider sees everything so far, and later text needs a new answer', async () => {
  const { turns, chat, say, seen, shared } = await setup();
  await say('private question', 'ollama');
  await turns.share(chat.id, 'claude', true);
  assert.deepEqual(shared, [`claude:${chat.id}`]);
  assert.equal((await turns.shareState(chat.id, 'claude')).ask, false);
  await say('next', 'claude');
  assert.deepEqual(seen.get('claude'), ['private question', 'from ollama', 'next']);

  await say('more private', 'ollama');
  assert.deepEqual(await turns.shareState(chat.id, 'claude'), { ask: true, unseen: 2, local: true });
  await say('and again', 'claude');
  assert.ok(!seen.get('claude')?.includes('more private'), 'a yes covers only what was said before it');
});

test('no: it stays hidden, and you are not asked again until there is something new', async () => {
  const { turns, chat, say, seen, shared } = await setup();
  await say('private question', 'ollama');
  await turns.share(chat.id, 'claude', false);
  assert.deepEqual(await turns.shareState(chat.id, 'claude'), { ask: false, unseen: 2, local: true });
  await say('next', 'claude');
  assert.deepEqual(seen.get('claude'), ['next']);
  assert.deepEqual(shared, []);

  await say('more', 'ollama');
  const again = await turns.shareState(chat.id, 'claude');
  assert.equal(again.ask, true);
  assert.equal(again.unseen, 4, 'a yes now would cover the earlier part too, so the count includes it');
});

test('an old chat with the model you\'re on asks nothing, and says nothing about private notes', async () => {
  const { turns, chat, store } = await setup();
  await store.append(chat.id, { role: 'user', parts: [{ type: 'text', text: 'old' }], meta: { turnId: 't1' } });
  await store.append(chat.id, { role: 'assistant', parts: [{ type: 'text', text: 'old reply' }], meta: { turnId: 't1', provider: 'claude', locality: 'cloud' } });
  assert.deepEqual(await turns.shareState(chat.id, 'claude'), { ask: false, unseen: 0, local: false });
  assert.deepEqual(await turns.shareState(chat.id, 'gpt'), { ask: true, unseen: 2, local: false }, 'it was a cloud chat, so no warning about local text');
});

test('no answer at all means not shared', async () => {
  const { chat, say, seen } = await setup();
  await say('private question', 'ollama');
  await say('straight to the cloud', 'claude');
  assert.deepEqual(seen.get('claude'), ['straight to the cloud']);
  void chat;
});

test('an answer can\'t land in the middle of a reply', async () => {
  const { turns, chat, release } = await setup();
  const { done } = await turns.start(chat.id, { text: 'hold', providerId: 'ollama', model: 'm', effort: 'auto', contextUuids: [] });
  await new Promise((r) => setTimeout(r, 20));
  await assert.rejects(turns.share(chat.id, 'claude', true), (e: TurnError) => e.status === 409);
  release();
  await done;
});

test('an unknown provider is refused, and the audit log holds the answer but no text', async () => {
  const { turns, chat, say, audit } = await setup();
  await assert.rejects(turns.shareState(chat.id, 'nobody'), (e: TurnError) => e.status === 400);
  await say('a very private sentence', 'ollama');
  await turns.share(chat.id, 'claude', true);
  await turns.share(chat.id, 'gpt', false);
  const log = await readFile(audit, 'utf8');
  assert.ok(!log.includes('very private'));
  const answers = log.trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.kind === 'consent');
  assert.deepEqual(answers.map((a) => [a.provider, a.outcome]), [['claude', 'shared 2 messages'], ['gpt', 'not shared']]);
});

import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { AuditLog } from '../src/audit.ts';
import { ChatStore, messageText, transcriptFor } from '../src/chats/store.ts';
import type { Locality, StoredMessage } from '../src/chats/store.ts';
import { TurnRunner } from '../src/chats/turns.ts';
import { handoff } from '../src/providers/claude-cli.ts';
import type { Provider, TurnRequest } from '../src/providers/types.ts';

function msg(role: 'user' | 'assistant', text: string, meta: StoredMessage['meta']): StoredMessage {
  return { id: text, role, ts: 0, parts: [{ type: 'text', text }], ...(meta ? { meta } : {}) };
}

const CLOUDY = { id: 'cloudy', locality: 'cloud' } as const;
const LOCALY = { id: 'localy', locality: 'local' } as const;

test('transcriptFor: a cloud model sees its own turns, and an unlabeled message counts as local', () => {
  const all = [
    msg('user', 'to cloud', { locality: 'cloud', provider: 'cloudy' }),
    msg('assistant', 'from cloud', { locality: 'cloud', provider: 'cloudy' }),
    msg('user', 'to local', { locality: 'local', provider: 'localy' }),
    msg('assistant', 'from local', { locality: 'local', provider: 'localy' }),
    msg('user', 'to another cloud', { locality: 'cloud', provider: 'rival' }),
    msg('assistant', 'from another cloud', { locality: 'cloud', provider: 'rival' }),
    msg('user', 'old, unlabeled', undefined),
  ];
  assert.deepEqual(transcriptFor(all, CLOUDY).map((m) => m.id), ['to cloud', 'from cloud']);
  assert.equal(transcriptFor(all, LOCALY).length, 7);
  assert.deepEqual(transcriptFor(all, CLOUDY, 4).map((m) => m.id), ['to cloud', 'from cloud', 'to local', 'from local'], 'shared up to there');
});

test('transcriptFor: your older messages belong to whoever replied to them', () => {
  const all = [
    msg('user', 'old question', { locality: 'cloud', turnId: 't1' }),
    msg('assistant', 'old answer', { locality: 'cloud', turnId: 't1', provider: 'rival' }),
    msg('user', 'mine', { locality: 'cloud', turnId: 't2' }),
    msg('assistant', 'my answer', { locality: 'cloud', turnId: 't2', provider: 'cloudy' }),
  ];
  assert.deepEqual(transcriptFor(all, CLOUDY).map((m) => m.id), ['mine', 'my answer']);
});

test('transcriptFor: a chat from before the labels still belongs to the model that answered it', () => {
  // What real older chats look like: nothing on your message but its turn.
  const all = [
    msg('user', 'old question', { turnId: 't1' }),
    msg('assistant', 'old answer', { turnId: 't1', provider: 'cloudy', locality: 'cloud' }),
    msg('user', 'old local question', { turnId: 't2', locality: 'local' }),
    msg('assistant', 'old local answer', { turnId: 't2', provider: 'localy', locality: 'local' }),
    msg('user', 'no reply, no labels', { turnId: 't3' }),
  ];
  assert.deepEqual(transcriptFor(all, CLOUDY).map((m) => m.id), ['old question', 'old answer']);
  assert.deepEqual(transcriptFor(all, { id: 'rival', locality: 'cloud' }), [], 'and only to that model');
});

test('every provider gets the filtered transcript, whatever it does with it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lsai-transcript-'));
  const store = new ChatStore(dir);
  const seen = new Map<string, string[]>();
  const fake = (id: string, locality: Locality): Provider => ({
    id,
    label: id,
    locality,
    models: async () => [{ id: 'm', label: 'm', efforts: ['auto'] }],
    runTurn: async (req: TurnRequest) => {
      seen.set(id, req.messages.map(messageText));
      req.emit({ type: 'text.delta', text: `reply from ${id}` });
      return { stopReason: 'end' };
    },
  });
  const turns = new TurnRunner({ store, providers: [fake('cloudy', 'cloud'), fake('localy', 'local')], audit: new AuditLog(join(dir, 'audit.jsonl')), epoch: 'e' });
  const chat = await store.create('t');
  const say = async (text: string, providerId: string): Promise<void> => {
    await (await turns.start(chat.id, { text, providerId, model: 'm', effort: 'auto', contextUuids: [] })).done;
  };
  await say('one', 'cloudy');
  await say('two, with a private note', 'localy');
  await say('three', 'cloudy');
  assert.deepEqual(seen.get('cloudy'), ['one', 'reply from cloudy', 'three']);
  assert.deepEqual(seen.get('localy'), ['one', 'reply from cloudy', 'two, with a private note']);
});

test('handoff: a long chat goes whole, however many messages and however long', () => {
  const long = 'x'.repeat(10_000);
  const m = Array.from({ length: 60 }, (_, i) => msg(i % 2 ? 'assistant' : 'user', `message ${i} ${long}`, { locality: 'local' }));
  const text = handoff([...m, msg('user', 'now', { locality: 'cloud' })], false);
  assert.match(text, /message 0 x/);
  assert.match(text, /message 59 x/);
  assert.ok(text.length > 600_000, 'nothing was cut');
});

test('handoff: all of it for a new session, only what came after Claude for a resumed one', () => {
  const m = [
    msg('user', 'first', { locality: 'cloud' }),
    msg('assistant', 'from claude', { locality: 'cloud', provider: 'claude' }),
    msg('user', 'second', { locality: 'cloud' }),
    msg('assistant', 'from another cloud model', { locality: 'cloud', provider: 'anthropic' }),
    msg('user', 'now', { locality: 'cloud' }),
  ];
  // A message you sent Claude that it never answered still has to reach it.
  const failed = [m[0], m[1], msg('user', 'it failed on this', { locality: 'cloud', provider: 'claude' }), msg('user', 'again', { locality: 'cloud', provider: 'claude' })] as StoredMessage[];
  assert.match(handoff(failed, true), /it failed on this/);
  assert.match(handoff(m, false), /User: first/);
  const resumed = handoff(m, true);
  assert.ok(!resumed.includes('first') && !resumed.includes('from claude'), 'claude already has these');
  assert.match(resumed, /User: second/);
  assert.match(resumed, /Assistant: from another cloud model/);
  assert.ok(!resumed.includes('now'), 'the new message goes in separately');
  assert.equal(handoff(m.slice(0, 2).concat(m[4] as StoredMessage), true), '', 'nothing new, nothing handed over');
});

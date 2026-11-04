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

test('transcriptFor: cloud sees only cloud turns, and an unlabeled message counts as local', () => {
  const all = [
    msg('user', 'to cloud', { locality: 'cloud' }),
    msg('assistant', 'from cloud', { locality: 'cloud' }),
    msg('user', 'to local', { locality: 'local' }),
    msg('assistant', 'from local', { locality: 'local' }),
    msg('user', 'old, unlabeled', undefined),
  ];
  assert.deepEqual(transcriptFor(all, 'cloud').map((m) => m.id), ['to cloud', 'from cloud']);
  assert.equal(transcriptFor(all, 'local').length, 5);
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

test('handoff: all of it for a new session, only what came after Claude for a resumed one', () => {
  const m = [
    msg('user', 'first', { locality: 'cloud' }),
    msg('assistant', 'from claude', { locality: 'cloud', provider: 'claude' }),
    msg('user', 'second', { locality: 'cloud' }),
    msg('assistant', 'from another cloud model', { locality: 'cloud', provider: 'anthropic' }),
    msg('user', 'now', { locality: 'cloud' }),
  ];
  assert.match(handoff(m, false), /User: first/);
  const resumed = handoff(m, true);
  assert.ok(!resumed.includes('first') && !resumed.includes('from claude'), 'claude already has these');
  assert.match(resumed, /User: second/);
  assert.match(resumed, /Assistant: from another cloud model/);
  assert.ok(!resumed.includes('now'), 'the new message goes in separately');
  assert.equal(handoff(m.slice(0, 2).concat(m[4] as StoredMessage), true), '', 'nothing new, nothing handed over');
});

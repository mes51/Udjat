import { beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Database } from '../client';
import { ConversationRepository } from './conversations';
import { MessageRepository } from './messages';
import { ServerProfileRepository } from './server-profiles';

let db: Database;
let profiles: ServerProfileRepository;
let convs: ConversationRepository;
let msgs: MessageRepository;

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  profiles = new ServerProfileRepository(db);
  convs = new ConversationRepository(db);
  msgs = new MessageRepository(db);
});

describe('ServerProfileRepository', () => {
  it('creates, updates, lists and deletes profiles with JSON columns', () => {
    const p = profiles.create({
      name: 'home',
      kind: 'ollama',
      baseUrl: 'http://10.0.0.2:11434',
      apiKey: null,
      defaultModel: 'qwen3:8b',
      defaultParams: { contextLength: 16384 },
      capabilityOverrides: { tools: true },
    });
    expect(p.defaultParams).toEqual({ contextLength: 16384 });
    expect(profiles.list()).toHaveLength(1);
    const u = profiles.update(p.id, { name: 'home2', defaultParams: { temperature: 0.3 } });
    expect(u).toMatchObject({ name: 'home2', defaultParams: { temperature: 0.3 }, kind: 'ollama' });
    expect(profiles.delete(p.id)).toBe(true);
    expect(profiles.get(p.id)).toBeNull();
  });
});

describe('ConversationRepository', () => {
  it('orders by pinned then updated_at and nulls the profile on profile delete', () => {
    const p = profiles.create({
      name: 'x',
      kind: 'llamacpp',
      baseUrl: 'http://h:8080',
      apiKey: null,
      defaultModel: null,
      defaultParams: {},
      capabilityOverrides: {},
    });
    const a = convs.create({ serverProfileId: p.id, model: 'm', title: 'A' });
    const b = convs.create({ serverProfileId: p.id, model: 'm', title: 'B' });
    convs.update(a.id, { pinned: true }, { touch: false });
    expect(convs.list().map((c) => c.title)).toEqual(['A', 'B']);
    profiles.delete(p.id);
    expect(convs.get(b.id)?.serverProfileId).toBeNull();
  });
});

describe('MessageRepository', () => {
  it('builds a tree, walks root->leaf paths and finds siblings', () => {
    const c = convs.create({ serverProfileId: null, model: null });
    const u1 = msgs.create({
      conversationId: c.id,
      parentId: null,
      role: 'user',
      parts: [{ type: 'text', text: 'こんにちは' }],
    });
    const a1 = msgs.create({
      conversationId: c.id,
      parentId: u1.id,
      role: 'assistant',
      parts: [{ type: 'text', text: '応答1' }],
    });
    const a2 = msgs.create({
      conversationId: c.id,
      parentId: u1.id,
      role: 'assistant',
      parts: [{ type: 'text', text: '応答2(再生成)' }],
    });
    const u2 = msgs.create({
      conversationId: c.id,
      parentId: a2.id,
      role: 'user',
      parts: [{ type: 'text', text: '続き' }],
    });

    expect(msgs.pathToRoot(u2.id).map((m) => m.id)).toEqual([u1.id, a2.id, u2.id]);
    expect(msgs.siblings(a1).map((m) => m.id)).toEqual([a1.id, a2.id]);
    expect(msgs.latestLeafUnder(u1.id).id).toBe(u2.id);
    expect(msgs.children(c.id, null).map((m) => m.id)).toEqual([u1.id]);
  });

  it('updates parts and keeps the FTS index in sync', () => {
    const c = convs.create({ serverProfileId: null, model: null });
    const m = msgs.create({
      conversationId: c.id,
      parentId: null,
      role: 'assistant',
      parts: [{ type: 'text', text: '最初の内容' }],
    });
    expect(msgs.search('最初の').map((r) => r.messageId)).toEqual([m.id]);
    expect(msgs.search('最初').map((r) => r.messageId)).toEqual([m.id]); // 3 文字未満は LIKE
    msgs.update(m.id, {
      parts: [
        { type: 'reasoning', text: '思考の過程' },
        { type: 'text', text: '動画のフレーム抽出' },
      ],
      finishReason: 'stop',
    });
    expect(msgs.search('最初の')).toEqual([]);
    expect(msgs.search('フレーム').map((r) => r.messageId)).toEqual([m.id]);
    expect(msgs.search('思考の')).toEqual([]); // reasoning は検索対象外
    expect(msgs.search('"or" AND')).toEqual([]); // MATCH のメタ文字でエラーにならない
    expect(msgs.get(m.id)?.finishReason).toBe('stop');
  });

  it('cascades deletes from conversation to messages and FTS', () => {
    const c = convs.create({ serverProfileId: null, model: null });
    const m = msgs.create({
      conversationId: c.id,
      parentId: null,
      role: 'user',
      parts: [{ type: 'text', text: 'abcdef' }],
    });
    convs.delete(c.id);
    expect(msgs.get(m.id)).toBeNull();
    expect(msgs.search('abc')).toEqual([]);
  });
});

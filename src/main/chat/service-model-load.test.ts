import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatRunEvent } from '@shared/schemas';
import { openDatabase, type Database } from '@main/db/client';
import { ConversationRepository } from '@main/db/repositories/conversations';
import { MessageRepository } from '@main/db/repositories/messages';
import { ServerProfileRepository } from '@main/db/repositories/server-profiles';
import { json, sse, startMockServer, type MockServer } from '@main/providers/test-server';
import { ToolRegistry } from '@main/tools/registry';
import { ChatService } from './service';

/** M10: 送信直前の自動ロード(llama.cpp router 風のモック) */

let db: Database;
let profiles: ServerProfileRepository;
let conversations: ConversationRepository;
let messages: MessageRepository;
let service: ChatService;
let events: ChatRunEvent[];
let server: MockServer | null = null;

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  profiles = new ServerProfileRepository(db);
  conversations = new ConversationRepository(db);
  messages = new MessageRepository(db);
  events = [];
  service = new ChatService({
    profiles,
    conversations,
    messages,
    tools: new ToolRegistry(db),
    emit: (e) => events.push(e),
    flushIntervalMs: 0,
    getSetting: (k) => (k === 'titles.auto' ? false : null),
  });
});

afterEach(async () => {
  await server?.close();
  server = null;
  db.close();
});

function routerMock(state: Record<string, string>) {
  return startMockServer({
    'GET /models': (_r, _b, res) => {
      for (const k of Object.keys(state)) if (state[k] === 'loading') state[k] = 'loaded';
      json(res, { data: Object.entries(state).map(([id, status]) => ({ id, status })) });
    },
    'POST /models/load': (_r, body, res) => {
      state[(body as { model: string }).model] = 'loading';
      json(res, { success: true });
    },
    'POST /models/unload': (_r, body, res) => {
      state[(body as { model: string }).model] = 'unloaded';
      json(res, { success: true });
    },
    'POST /v1/chat/completions': (_r, _b, res) =>
      sse(res, [{ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }]),
  });
}

async function sendAndWait(profileId: string, model: string) {
  const c = conversations.create({ serverProfileId: profileId, model });
  const run = await service.send({ conversationId: c.id, text: 'hello' });
  await service.waitFor(run.runId);
  return c;
}

describe('ChatService model auto-load', () => {
  it('loads the selected model before sending, unloading others by default', async () => {
    const state: Record<string, string> = { small: 'loaded', big: 'unloaded' };
    server = await routerMock(state);
    const p = profiles.create({
      name: 'router',
      kind: 'llamacpp',
      baseUrl: server.url,
      apiKey: null,
      defaultModel: 'big',
      defaultParams: {},
      capabilityOverrides: {},
    });
    expect(p.modelManagement).toEqual({ autoLoad: true, unloadOthers: true });
    await sendAndWait(p.id, 'big');
    const calls = server.requests.map((r) => `${r.method} ${r.path}`);
    expect(calls.filter((c) => c.startsWith('POST'))).toEqual([
      'POST /models/unload',
      'POST /models/load',
      'POST /v1/chat/completions',
    ]);
    expect(state).toEqual({ small: 'unloaded', big: 'loaded' });
    const loadEvents = events.map((e) => e.event).filter((e) => e.type === 'model-load');
    expect(loadEvents.map((e) => (e.type === 'model-load' ? e.state : ''))).toEqual([
      'loading',
      'done',
    ]);
    const text = events
      .map((e) => e.event)
      .filter((e) => e.type === 'text-delta')
      .map((e) => (e.type === 'text-delta' ? e.text : ''))
      .join('');
    expect(text).toBe('hi');
  });

  it('skips loading when the model is already resident or autoLoad is off', async () => {
    const state: Record<string, string> = { small: 'loaded', big: 'unloaded' };
    server = await routerMock(state);
    const p = profiles.create({
      name: 'router',
      kind: 'llamacpp',
      baseUrl: server.url,
      apiKey: null,
      defaultModel: 'small',
      defaultParams: {},
      capabilityOverrides: {},
    });
    await sendAndWait(p.id, 'small');
    expect(server.requests.some((r) => r.path === '/models/load')).toBe(false);
    expect(events.some((e) => e.event.type === 'model-load')).toBe(false);

    profiles.update(p.id, { modelManagement: { autoLoad: false, unloadOthers: true } });
    await sendAndWait(p.id, 'big');
    expect(server.requests.some((r) => r.path === '/models/load')).toBe(false);
    expect(state['big']).toBe('unloaded');
  });

  it('reports a load failure as the run error', async () => {
    server = await startMockServer({
      'GET /models': (_r, _b, res) => json(res, { data: [{ id: 'm', status: 'unloaded' }] }),
      'POST /models/load': (_r, _b, res) => json(res, { error: 'out of memory' }, 500),
    });
    const p = profiles.create({
      name: 'router',
      kind: 'llamacpp',
      baseUrl: server.url,
      apiKey: null,
      defaultModel: 'm',
      defaultParams: {},
      capabilityOverrides: {},
    });
    const c = await sendAndWait(p.id, 'm');
    const path = messages.pathToRoot(conversations.get(c.id)!.activeLeafId!);
    const assistant = path.at(-1)!;
    expect(assistant.error).toContain('ロードに失敗');
    expect(assistant.error).toContain('out of memory');
    const states = events
      .map((e) => e.event)
      .filter((e) => e.type === 'model-load')
      .map((e) => (e.type === 'model-load' ? e.state : ''));
    expect(states).toEqual(['loading', 'error']);
    expect(server.requests.some((r) => r.path === '/v1/chat/completions')).toBe(false);
  });
});

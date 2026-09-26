import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatRunEvent } from '@shared/schemas';
import { openDatabase, type Database } from '@main/db/client';
import { ConversationRepository } from '@main/db/repositories/conversations';
import { MessageRepository } from '@main/db/repositories/messages';
import { ServerProfileRepository } from '@main/db/repositories/server-profiles';
import { json, ndjson, sse, startMockServer, type MockServer } from '@main/providers/test-server';
import { ToolRegistry } from '@main/tools/registry';
import { ChatService } from './service';

let db: Database;
let server: MockServer | null = null;
let autoTitle = false;
let events: ChatRunEvent[];
let service: ChatService;
let profiles: ServerProfileRepository;
let conversations: ConversationRepository;
let messages: MessageRepository;

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
    getSetting: (k) => (k === 'titles.auto' ? autoTitle : null),
  });
});

afterEach(async () => {
  await server?.close();
  server = null;
  db.close();
  autoTitle = false;
});

describe('ChatService title generation', () => {
  it('asks the model for a short title after the first exchange and edits user messages as siblings', async () => {
    autoTitle = true;
    server = await startMockServer({
      'POST /v1/chat/completions': (_r, body, res) => {
        const msgs = (body as { messages: { content: string }[] }).messages;
        const isTitle = msgs[0]?.content.includes('short title');
        sse(res, [
          {
            choices: [
              {
                delta: { content: isTitle ? '「天気の質問」。\n' : '晴れです' },
                finish_reason: 'stop',
              },
            ],
          },
        ]);
      },
    });
    const p = profiles.create({
      name: 'l',
      kind: 'llamacpp',
      baseUrl: server.url,
      apiKey: null,
      defaultModel: 'm',
      defaultParams: {},
      capabilityOverrides: {},
    });
    const c = conversations.create({ serverProfileId: p.id, model: null });
    const r1 = await service.send({ conversationId: c.id, text: '今日の天気は?' });
    await service.waitFor(r1.runId);
    expect(conversations.get(c.id)!.title).toBe('天気の質問');
    // タイトル生成のリクエストは think を切り、短い max_tokens で送る
    const titleReq = server.requests.find((r) => JSON.stringify(r.body).includes('short title'))!
      .body as Record<string, unknown>;
    expect(titleReq).toMatchObject({ max_tokens: 48, reasoning_budget: 0 });

    // 2 往復目以降はタイトルを付け直さない
    const r2 = await service.send({ conversationId: c.id, text: '明日は?' });
    await service.waitFor(r2.runId);
    expect(
      server.requests.filter((r) => JSON.stringify(r.body).includes('short title')),
    ).toHaveLength(1);

    // 編集: 元のユーザー発言と同じ親の下に新しい分岐
    const before = messages.pathToRoot(conversations.get(c.id)!.activeLeafId!);
    const r3 = await service.edit(before[2]!.id, '明後日は?');
    await service.waitFor(r3.runId);
    const after = messages.pathToRoot(conversations.get(c.id)!.activeLeafId!);
    expect(after.map((m) => (m.parts[0] as { text: string }).text)).toEqual([
      '今日の天気は?',
      '晴れです',
      '明後日は?',
      '晴れです',
    ]);
    expect(messages.get(r3.userMessageId!)!.parentId).toBe(before[2]!.parentId);
    expect(messages.branches(after)[after[2]!.id]).toEqual({
      index: 1,
      count: 2,
      ids: [before[2]!.id, after[2]!.id],
    });
  });
});

describe('ChatService', () => {
  it('sends a message through Ollama, streams events and persists the tree', async () => {
    server = await startMockServer({
      'POST /api/show': (_r, _b, res) => json(res, { capabilities: ['completion', 'thinking'] }),
      'POST /api/chat': (_r, _b, res) =>
        ndjson(res, [
          { message: { content: '', thinking: '考え中' }, done: false },
          { message: { content: 'こんにちは、' }, done: false },
          { message: { content: '元気です。' }, done: false },
          {
            message: { content: '' },
            done: true,
            done_reason: 'stop',
            prompt_eval_count: 8,
            eval_count: 6,
            eval_duration: 3e8,
          },
        ]),
    });
    const p = profiles.create({
      name: 'o',
      kind: 'ollama',
      baseUrl: server.url,
      apiKey: null,
      defaultModel: 'qwen3:8b',
      defaultParams: {},
      capabilityOverrides: {},
    });
    const c = conversations.create({ serverProfileId: p.id, model: null, systemPrompt: '短く' });

    const run = await service.send({ conversationId: c.id, text: 'やあ、元気?' });
    await service.waitFor(run.runId);

    // イベント列
    expect(events.map((e) => e.event.type)).toEqual([
      'reasoning-delta',
      'text-delta',
      'text-delta',
      'usage',
      'done',
      'run-end',
    ]);
    expect(
      events.every((e) => e.runId === run.runId && e.messageId === run.assistantMessageId),
    ).toBe(true);

    // 永続化
    const assistant = messages.get(run.assistantMessageId)!;
    expect(assistant.parts).toEqual([
      { type: 'reasoning', text: '考え中' },
      { type: 'text', text: 'こんにちは、元気です。' },
    ]);
    expect(assistant.finishReason).toBe('stop');
    expect(assistant.usage).toEqual({ promptTokens: 8, completionTokens: 6, durationMs: 300 });
    expect(assistant.model).toBe('qwen3:8b');
    const conv = conversations.get(c.id)!;
    expect(conv.activeLeafId).toBe(run.assistantMessageId);
    expect(conv.title).toBe('やあ、元気?');
    expect(messages.pathToRoot(run.assistantMessageId).map((m) => m.role)).toEqual([
      'user',
      'assistant',
    ]);

    // サーバーに送った内容
    const body = server.requests.find((r) => r.path === '/api/chat')?.body as {
      messages: unknown[];
    };
    expect(body.messages).toEqual([
      { role: 'system', content: '短く' },
      { role: 'user', content: 'やあ、元気?' },
    ]);
  });

  it('continues a conversation from the active leaf and regenerates as a sibling', async () => {
    let n = 0;
    server = await startMockServer({
      'GET /v1/models': (_r, _b, res) => json(res, { data: [{ id: 'm' }] }),
      'POST /v1/chat/completions': (_r, _b, res) =>
        sse(res, [{ choices: [{ delta: { content: `answer ${++n}` }, finish_reason: 'stop' }] }]),
    });
    const p = profiles.create({
      name: 'l',
      kind: 'llamacpp',
      baseUrl: server.url,
      apiKey: null,
      defaultModel: 'm',
      defaultParams: {},
      capabilityOverrides: {},
    });
    const c = conversations.create({ serverProfileId: p.id, model: null });

    const r1 = await service.send({ conversationId: c.id, text: 'first' });
    await service.waitFor(r1.runId);
    const r2 = await service.send({ conversationId: c.id, text: 'second' });
    await service.waitFor(r2.runId);
    const r3 = await service.regenerate(r2.assistantMessageId);
    await service.waitFor(r3.runId);

    const sent = server.requests
      .filter((r) => r.path === '/v1/chat/completions')
      .map((r) => (r.body as { messages: { content: string }[] }).messages.map((m) => m.content));
    expect(sent).toEqual([
      ['first'],
      ['first', 'answer 1', 'second'],
      ['first', 'answer 1', 'second'],
    ]);

    const path = messages.pathToRoot(conversations.get(c.id)!.activeLeafId!);
    expect(path.map((m) => (m.parts[0] && 'text' in m.parts[0] ? m.parts[0].text : ''))).toEqual([
      'first',
      'answer 1',
      'second',
      'answer 3',
    ]);
    const regenerated = messages.get(r3.assistantMessageId)!;
    expect(messages.siblings(regenerated)).toHaveLength(2);
  });

  it('records provider errors on the assistant message', async () => {
    server = await startMockServer({
      'POST /v1/chat/completions': (_r, _b, res) =>
        json(res, { error: { message: 'model not loaded' } }, 500),
    });
    const p = profiles.create({
      name: 'l',
      kind: 'lmstudio',
      baseUrl: server.url,
      apiKey: null,
      defaultModel: 'm',
      defaultParams: {},
      capabilityOverrides: {},
    });
    const c = conversations.create({ serverProfileId: p.id, model: null });
    const run = await service.send({ conversationId: c.id, text: 'x' });
    await service.waitFor(run.runId);
    expect(events.map((e) => e.event.type)).toEqual(['error', 'done', 'run-end']);
    const a = messages.get(run.assistantMessageId)!;
    expect(a.finishReason).toBe('error');
    expect(a.error).toMatch(/500.*model not loaded/);
  });

  it('keeps partial output when aborted', async () => {
    server = await startMockServer({
      'POST /v1/chat/completions': (_r, _b, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })}\n\n`);
        const t = setInterval(() => res.write(': ping\n\n'), 20);
        res.on('close', () => clearInterval(t));
      },
    });
    const p = profiles.create({
      name: 'v',
      kind: 'vllm',
      baseUrl: server.url,
      apiKey: null,
      defaultModel: 'm',
      defaultParams: {},
      capabilityOverrides: {},
    });
    const c = conversations.create({ serverProfileId: p.id, model: null });
    const run = await service.send({ conversationId: c.id, text: 'x' });
    await new Promise<void>((resolve) => {
      const check = () =>
        events.some((e) => e.event.type === 'text-delta') ? resolve() : setTimeout(check, 5);
      check();
    });
    expect(service.isRunning(c.id)).toBe(run.runId);
    expect(service.abort(run.runId)).toBe(true);
    await service.waitFor(run.runId);
    const a = messages.get(run.assistantMessageId)!;
    expect(a.parts).toEqual([{ type: 'text', text: 'partial' }]);
    expect(a.finishReason).toBe('aborted');
    expect(events.at(-2)?.event).toEqual({ type: 'done', finishReason: 'aborted' });
    expect(events.at(-1)?.event).toEqual({ type: 'run-end' });
    expect(service.isRunning(c.id)).toBeNull();
  });
});

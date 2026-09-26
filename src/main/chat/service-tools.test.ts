import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatRunEvent } from '@shared/schemas';
import { openDatabase, type Database } from '@main/db/client';
import { ConversationRepository } from '@main/db/repositories/conversations';
import { MessageRepository } from '@main/db/repositories/messages';
import { ServerProfileRepository } from '@main/db/repositories/server-profiles';
import { sse, startMockServer, type MockServer } from '@main/providers/test-server';
import { ToolRegistry } from '@main/tools/registry';
import { ok } from '@main/tools/types';
import { ChatService } from './service';

let db: Database;
let server: MockServer | null = null;
let events: ChatRunEvent[];
let service: ChatService;
let registry: ToolRegistry;
let profiles: ServerProfileRepository;
let conversations: ConversationRepository;
let messages: MessageRepository;
let executed: { name: string; args: Record<string, unknown> }[];

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  profiles = new ServerProfileRepository(db);
  conversations = new ConversationRepository(db);
  messages = new MessageRepository(db);
  registry = new ToolRegistry(db);
  executed = [];
  registry.register({
    definition: {
      name: 'get_weather',
      description: 'weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
    source: { kind: 'builtin' },
    defaultPolicy: 'auto',
    execute: async (args) => {
      executed.push({ name: 'get_weather', args });
      return ok(JSON.stringify({ city: args['city'], temp: 21 }));
    },
  });
  events = [];
  service = new ChatService({
    profiles,
    conversations,
    messages,
    tools: registry,
    emit: (e) => events.push(e),
    flushIntervalMs: 0,
    maxToolIterations: 3,
  });
});

afterEach(async () => {
  await server?.close();
  server = null;
  db.close();
});

/** 1 回目は tool_calls、2 回目以降は最終回答を返す OpenAI 互換モック */
function toolThenAnswerServer(opts: { alwaysCallTool?: boolean } = {}) {
  let n = 0;
  return startMockServer({
    'POST /v1/chat/completions': (_r, body, res) => {
      n++;
      const msgs = (body as { messages: { role: string }[] }).messages;
      // 直前がツール結果なら最終回答、ユーザー発言なら tool_calls を返す
      const lastIsToolResult = msgs.at(-1)?.role === 'tool';
      if (!lastIsToolResult || opts.alwaysCallTool) {
        sse(res, [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: `call_${n}`,
                      function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' },
                    },
                  ],
                },
              },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]);
      } else {
        sse(res, [
          { choices: [{ delta: { content: '東京は 21 度です' }, finish_reason: 'stop' }] },
        ]);
      }
    },
  });
}

async function setup() {
  const p = profiles.create({
    name: 'l',
    kind: 'llamacpp',
    baseUrl: server!.url,
    apiKey: null,
    defaultModel: 'm',
    defaultParams: {},
    capabilityOverrides: {},
  });
  return conversations.create({ serverProfileId: p.id, model: null });
}

describe('ChatService tool loop', () => {
  it('executes auto-approved tools and continues until a final answer', async () => {
    server = await toolThenAnswerServer();
    const c = await setup();
    const run = await service.send({ conversationId: c.id, text: '東京の天気は?' });
    await service.waitFor(run.runId);

    expect(executed).toEqual([{ name: 'get_weather', args: { city: 'Tokyo' } }]);
    const path = messages.pathToRoot(conversations.get(c.id)!.activeLeafId!);
    expect(path.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(path[1]!.toolCalls).toEqual([
      { id: 'call_1', name: 'get_weather', args: '{"city":"Tokyo"}' },
    ]);
    expect(path[1]!.finishReason).toBe('tool_calls');
    expect(path[2]).toMatchObject({
      toolCallId: 'call_1',
      parts: [{ type: 'text', text: '{"city":"Tokyo","temp":21}' }],
      toolMeta: { name: 'get_weather', isError: false, approval: 'auto' },
    });
    expect(path[3]!.parts).toEqual([{ type: 'text', text: '東京は 21 度です' }]);
    expect(path[3]!.finishReason).toBe('stop');

    const types = events.map((e) => e.event.type);
    expect(types).toEqual([
      'tool-call',
      'usage',
      'done',
      'tool-start',
      'tool-end',
      'path-changed',
      'text-delta',
      'usage',
      'done',
      'run-end',
    ]);
    // 2 セグメント目のイベントは新しい assistant メッセージ id を持つ
    expect(events.at(-1)?.messageId).toBe(path[3]!.id);

    // サーバーには tools 定義と tool 結果が送られている
    const second = server.requests[1]!.body as {
      tools: unknown[];
      messages: { role: string; tool_call_id?: string }[];
    };
    expect(second.tools).toHaveLength(1);
    expect(second.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(second.messages[2]!.tool_call_id).toBe('call_1');
  });

  it('regenerates from the last user message, discarding earlier tool results', async () => {
    server = await toolThenAnswerServer();
    const c = await setup();
    const r1 = await service.send({ conversationId: c.id, text: '東京の天気は?' });
    await service.waitFor(r1.runId);
    const before = messages.pathToRoot(conversations.get(c.id)!.activeLeafId!);
    expect(before.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);

    // 最後の assistant セグメントから再生成しても、直前のユーザー発言の直下に新しい分岐ができる
    const r2 = await service.regenerate(before[3]!.id);
    expect(r2.userMessageId).toBeNull();
    const created = messages.get(r2.assistantMessageId)!;
    expect(created.parentId).toBe(before[0]!.id);
    await service.waitFor(r2.runId);

    const after = messages.pathToRoot(conversations.get(c.id)!.activeLeafId!);
    expect(after.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(after[1]!.id).not.toBe(before[1]!.id);
    // 元の分岐は兄弟として残る
    expect(messages.children(c.id, before[0]!.id).map((m) => m.id)).toEqual([
      before[1]!.id,
      after[1]!.id,
    ]);
    // 新しい分岐ではツールが改めて呼ばれている
    expect(executed).toHaveLength(2);
    // 再生成に送った履歴に古いツール結果は含まれない
    const regenRequest = server.requests.filter((r) => r.path === '/v1/chat/completions')[2]!
      .body as {
      messages: { role: string }[];
    };
    expect(regenRequest.messages.map((m) => m.role)).toEqual(['user']);
  });

  it('waits for approval when the policy is ask, and honours deny', async () => {
    server = await toolThenAnswerServer();
    registry.setPolicy('get_weather', 'ask');
    const c = await setup();

    const run = await service.send({ conversationId: c.id, text: 'x' });
    await waitUntil(() => events.some((e) => e.event.type === 'tool-approval-request'));
    expect(executed).toHaveLength(0);
    expect(service.approve(run.runId, 'call_1', 'deny')).toBe(true);
    await service.waitFor(run.runId);

    const path = messages.pathToRoot(conversations.get(c.id)!.activeLeafId!);
    expect(path[2]).toMatchObject({
      role: 'tool',
      toolMeta: { approval: 'denied', isError: true },
    });
    expect(executed).toHaveLength(0);
    // モデルには拒否がエラー結果として伝わり、最終回答まで進む
    expect(path[3]!.role).toBe('assistant');
    expect(path[3]!.finishReason).toBe('stop');
  });

  it('remembers allow-conversation approvals', async () => {
    server = await toolThenAnswerServer();
    registry.setPolicy('get_weather', 'ask');
    const c = await setup();

    const r1 = await service.send({ conversationId: c.id, text: 'x' });
    await waitUntil(() => events.some((e) => e.event.type === 'tool-approval-request'));
    service.approve(r1.runId, 'call_1', 'allow-conversation');
    await service.waitFor(r1.runId);
    expect(executed).toHaveLength(1);

    events = [];
    const r2 = await service.send({ conversationId: c.id, text: 'y' });
    await service.waitFor(r2.runId);
    expect(events.some((e) => e.event.type === 'tool-approval-request')).toBe(false);
    expect(executed).toHaveLength(2);
  });

  it('stops at the iteration limit', async () => {
    server = await toolThenAnswerServer({ alwaysCallTool: true });
    const c = await setup();
    const run = await service.send({ conversationId: c.id, text: 'loop' });
    await service.waitFor(run.runId);
    // maxToolIterations = 3 はモデル呼び出しの回数。ツール実行はその間の 2 回
    expect(executed).toHaveLength(2);
    const path = messages.pathToRoot(conversations.get(c.id)!.activeLeafId!);
    const note = messages.children(c.id, path.at(-1)!.id);
    expect(note[0]).toMatchObject({ kind: 'note' });
    expect((note[0]!.parts[0] as { text: string }).text).toMatch(/上限/);
  });

  it('aborting while waiting for approval ends the run cleanly', async () => {
    server = await toolThenAnswerServer();
    registry.setPolicy('get_weather', 'ask');
    const c = await setup();
    const run = await service.send({ conversationId: c.id, text: 'x' });
    await waitUntil(() => events.some((e) => e.event.type === 'tool-approval-request'));
    service.abort(run.runId);
    await service.waitFor(run.runId);
    expect(events.at(-2)?.event).toEqual({ type: 'done', finishReason: 'aborted' });
    expect(events.at(-1)?.event).toEqual({ type: 'run-end' });
    expect(service.approve(run.runId, 'call_1', 'allow')).toBe(false);
  });
});

async function waitUntil(pred: () => boolean, timeout = 5000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeout) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

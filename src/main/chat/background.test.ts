import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatRunEvent, ToolMeta } from '@shared/schemas';
import { openDatabase, type Database } from '@main/db/client';
import { ConversationRepository } from '@main/db/repositories/conversations';
import { MessageRepository } from '@main/db/repositories/messages';
import { ServerProfileRepository } from '@main/db/repositories/server-profiles';
import { chatRequests, sse, startMockServer, type MockServer } from '@main/providers/test-server';
import { ToolRegistry } from '@main/tools/registry';
import { ok } from '@main/tools/types';
import { ChatService } from './service';

/**
 * M16: 長いツール呼び出しをバックグラウンドタスクに切り離し、完了後に応答を再開する。
 */

let db: Database;
let profiles: ServerProfileRepository;
let conversations: ConversationRepository;
let messages: MessageRepository;
let registry: ToolRegistry;
let server: MockServer | null = null;
let events: ChatRunEvent[];
let settings: Record<string, unknown>;
let service: ChatService;
/** slow_job の完了を外から制御する */
let release: (() => void) | null = null;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(pred: () => boolean, timeout = 5000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > timeout) throw new Error('timeout waiting');
    await sleep(10);
  }
}

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  profiles = new ServerProfileRepository(db);
  conversations = new ConversationRepository(db);
  messages = new MessageRepository(db);
  registry = new ToolRegistry(db);
  registry.register({
    definition: {
      name: 'slow_job',
      description: 'slow',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    source: { kind: 'builtin' },
    category: 'basic',
    defaultPolicy: 'auto',
    execute: (_args, ctx) =>
      new Promise((resolve, reject) => {
        release = () => resolve(ok('{"job":"done"}'));
        ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
  });
  registry.register({
    definition: {
      name: 'quick',
      description: 'quick',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    source: { kind: 'builtin' },
    category: 'basic',
    defaultPolicy: 'auto',
    execute: async () => ok('fast'),
  });
  events = [];
  settings = { 'titles.auto': false, 'tools.backgroundAfterMs': 50 };
  service = new ChatService({
    profiles,
    conversations,
    messages,
    tools: registry,
    emit: (e) => events.push(e),
    flushIntervalMs: 0,
    getSetting: (k) => settings[k] ?? null,
  });
});

afterEach(async () => {
  await server?.close();
  server = null;
  db.close();
});

/** 1 回目は slow_job(と quick)を呼び、ツール結果が揃ったら最終回答を返す */
async function setup(callQuickToo = false) {
  server = await startMockServer({
    'POST /v1/chat/completions': (_r, body, res) => {
      const msgs = (body as { messages: { role: string }[] }).messages;
      if (msgs.at(-1)?.role === 'tool') {
        sse(res, [{ choices: [{ delta: { content: '完了しました' }, finish_reason: 'stop' }] }]);
        return;
      }
      const calls = [
        { index: 0, id: 'call_slow', function: { name: 'slow_job', arguments: '{}' } },
        ...(callQuickToo
          ? [{ index: 1, id: 'call_quick', function: { name: 'quick', arguments: '{}' } }]
          : []),
      ];
      sse(res, [
        { choices: [{ delta: { tool_calls: calls } }] },
        { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
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
    capabilityOverrides: { tools: true },
    modelManagement: { autoLoad: false, unloadOthers: false },
  });
  return conversations.create({ serverProfileId: p.id, model: null });
}

describe('background tool tasks', () => {
  it('detaches a slow tool, ends the run, and resumes the answer when the tool finishes', async () => {
    const c = await setup(true);
    const run = await service.send({ conversationId: c.id, text: 'go' });
    await service.waitFor(run.runId);

    // run は切り離しで終わり、tool メッセージは実行中の印、quick の結果もその後ろに並ぶ
    const starts = events.filter((e) => e.event.type === 'tool-background');
    expect(starts.map((e) => (e.event as { state: string }).state)).toEqual(['start']);
    let path = messages.pathToRoot(conversations.get(c.id)!.activeLeafId!);
    expect(path.map((m) => `${m.role}:${(m.toolMeta as ToolMeta | null)?.name ?? ''}`)).toEqual([
      'user:',
      'assistant:',
      'tool:slow_job',
      'tool:quick',
    ]);
    expect((path[2]!.toolMeta as ToolMeta).background?.status).toBe('running');
    expect(service.backgroundTasks(c.id)).toHaveLength(1);
    expect(service.backgroundTasks(c.id)[0]).toMatchObject({
      callId: 'call_slow',
      name: 'slow_job',
    });
    expect(service.isRunning(c.id)).toBeNull();
    await expect(service.send({ conversationId: c.id, text: 'x' })).rejects.toThrow(
      /バックグラウンド/,
    );

    // タスク完了 → 結果を書き込み → assistant を再開して最終回答
    release!();
    await waitUntil(() => events.some((e) => e.event.type === 'run-end' && e.runId !== run.runId));
    await waitUntil(() => {
      const leaf = conversations.get(c.id)!.activeLeafId!;
      return messages.get(leaf)?.finishReason === 'stop';
    });
    path = messages.pathToRoot(conversations.get(c.id)!.activeLeafId!);
    expect(path.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant']);
    const slow = path[2]!;
    expect(slow.parts[0]).toEqual({ type: 'text', text: '{"job":"done"}' });
    expect((slow.toolMeta as ToolMeta).background?.status).toBe('done');
    expect(path[4]!.parts[0]).toEqual({ type: 'text', text: '完了しました' });
    expect(service.backgroundTasks()).toHaveLength(0);
    // 再開時の要求には両方のツール結果が入っている
    const last = chatRequests(server!).at(-1)!.body as {
      messages: { role: string; content: string }[];
    };
    expect(last.messages.filter((m) => m.role === 'tool').map((m) => m.content)).toEqual([
      '{"job":"done"}',
      'fast',
    ]);
  });

  it('aborting a task records an error and does not resume', async () => {
    const c = await setup();
    const run = await service.send({ conversationId: c.id, text: 'go' });
    await service.waitFor(run.runId);
    expect(service.abortTask(c.id, 'call_slow')).toBe(true);
    await waitUntil(() => service.backgroundTasks().length === 0);
    await sleep(50);
    const path = messages.pathToRoot(conversations.get(c.id)!.activeLeafId!);
    expect(path.map((m) => `${m.role}:${m.kind}`)).toEqual([
      'user:normal',
      'assistant:normal',
      'tool:normal',
      'assistant:note',
    ]);
    expect((path[2]!.toolMeta as ToolMeta).background?.status).toBe('aborted');
    expect(path[2]!.parts[0]).toMatchObject({ text: expect.stringContaining('中断') });
    expect(service.abortTask(c.id, 'call_slow')).toBe(false);
    // 中断後は普通に送れる
    release = null;
    const again = await service.send({ conversationId: c.id, text: 'next' });
    await service.waitFor(again.runId);
  });

  it('does not detach when the setting is 0 and the tool finishes normally', async () => {
    const c = await setup();
    settings['tools.backgroundAfterMs'] = 0;
    setTimeout(() => release?.(), 30);
    const run = await service.send({ conversationId: c.id, text: 'go' });
    await service.waitFor(run.runId);
    expect(events.some((e) => e.event.type === 'tool-background')).toBe(false);
    const path = messages.pathToRoot(conversations.get(c.id)!.activeLeafId!);
    expect(path.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
  });

  it('marks tasks left running by a previous process as lost on startup', async () => {
    const c = await setup();
    const run = await service.send({ conversationId: c.id, text: 'go' });
    await service.waitFor(run.runId);
    // 新しい ChatService(= アプリ再起動)は running のまま残った tool メッセージを lost にする
    const fresh = new ChatService({
      profiles,
      conversations,
      messages,
      tools: registry,
      emit: () => undefined,
      getSetting: () => null,
    });
    expect(fresh.backgroundTasks()).toHaveLength(0);
    const path = messages.pathToRoot(conversations.get(c.id)!.activeLeafId!);
    expect((path[2]!.toolMeta as ToolMeta).background?.status).toBe('lost');
    expect(path[2]!.parts[0]).toMatchObject({ text: expect.stringContaining('中断') });
    service.abortTask(c.id, 'call_slow');
  });
});

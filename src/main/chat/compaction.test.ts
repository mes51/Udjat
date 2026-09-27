import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChatRunEvent, Message } from '@shared/schemas';
import { estimateTokens } from '@shared/tokens';
import { openDatabase, type Database } from '@main/db/client';
import { ConversationRepository } from '@main/db/repositories/conversations';
import { MessageRepository } from '@main/db/repositories/messages';
import { ServerProfileRepository } from '@main/db/repositories/server-profiles';
import { guessFromModelName } from '@main/providers';
import { chatRequests, sse, startMockServer, type MockServer } from '@main/providers/test-server';
import { ToolRegistry } from '@main/tools/registry';
import { buildChatRequest, splitAtCompaction } from './message-builder';
import { ChatService, renderTranscript } from './service';

/**
 * M14: コンテキスト使用量とコンパクション(docs/plan/09-context-and-compaction.md)。
 */

describe('estimateTokens', () => {
  it('counts CJK per character and other text per 4 chars', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcdefgh')).toBe(2);
    expect(estimateTokens('こんにちは')).toBe(5);
    expect(estimateTokens('日本語 and english')).toBe(3 + Math.ceil(12 / 4));
  });
});

function msg(partial: Partial<Message> & Pick<Message, 'id' | 'role' | 'parts'>): Message {
  return {
    conversationId: 'c',
    parentId: null,
    kind: 'normal',
    toolCalls: null,
    toolCallId: null,
    toolMeta: null,
    model: null,
    usage: null,
    finishReason: null,
    error: null,
    createdAt: 0,
    ...partial,
  };
}

describe('splitAtCompaction / buildChatRequest', () => {
  const path = [
    msg({ id: '1', role: 'user', parts: [{ type: 'text', text: 'old question' }] }),
    msg({ id: '2', role: 'assistant', parts: [{ type: 'text', text: 'old answer' }] }),
    msg({
      id: '3',
      role: 'user',
      kind: 'compaction',
      parts: [{ type: 'text', text: 'SUMMARY: user asked old question' }],
    }),
    msg({ id: '4', role: 'user', parts: [{ type: 'text', text: 'new question' }] }),
  ];

  it('drops messages before the last compaction and moves the summary into the system prompt', async () => {
    expect(splitAtCompaction(path).history.map((m) => m.id)).toEqual(['4']);
    expect(splitAtCompaction(path.slice(0, 2)).summary).toBeNull();
    const req = await buildChatRequest({
      conversation: {
        id: 'c',
        title: '',
        pinned: false,
        serverProfileId: 'p',
        model: 'm',
        systemPrompt: 'be brief',
        params: {},
        disabledCategories: [],
        disabledTools: [],
        activeLeafId: null,
        createdAt: 0,
        updatedAt: 0,
      },
      profile: {
        id: 'p',
        name: 'p',
        kind: 'llamacpp',
        baseUrl: 'http://h',
        apiKey: null,
        defaultModel: 'm',
        defaultParams: {},
        capabilityOverrides: {},
        modelCapabilityOverrides: {},
        modelManagement: { autoLoad: false, unloadOthers: false },
        createdAt: 0,
        updatedAt: 0,
      },
      capabilities: guessFromModelName('llamacpp', 'm'),
      path,
    });
    expect(req.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(req.messages[0]!.text).toMatch(/^be brief\n\n# Summary of the earlier conversation/);
    expect(req.messages[0]!.text).toContain('SUMMARY: user asked old question');
    expect(req.messages[1]!.text).toBe('new question');
  });

  it('renders a transcript with attachment ids and drops old blocks over budget', () => {
    const t = renderTranscript(
      [
        msg({
          id: '1',
          role: 'user',
          parts: [
            { type: 'text', text: 'look' },
            { type: 'video', attachmentId: 'v1', name: 'clip.mp4', sendMode: 'tools' },
          ],
        }),
        msg({
          id: '2',
          role: 'assistant',
          parts: [{ type: 'reasoning', text: 'hidden' }],
          toolCalls: [{ id: 'c1', name: 'video_info', args: '{"video_id":"v1"}' }],
        }),
        msg({
          id: '3',
          role: 'tool',
          parts: [{ type: 'text', text: 'x'.repeat(2000) }],
          toolMeta: { name: 'video_info' },
        }),
        msg({ id: '4', role: 'assistant', parts: [{ type: 'text', text: 'done' }] }),
      ],
      100_000,
    );
    expect(t).toContain('video_id=v1');
    expect(t).toContain('[tool call video_info(');
    expect(t).not.toContain('hidden');
    expect(t).toMatch(/\[tool result video_info\] x{500} …/);
    const small = renderTranscript(
      [
        msg({ id: '1', role: 'user', parts: [{ type: 'text', text: 'a'.repeat(300) }] }),
        msg({ id: '2', role: 'assistant', parts: [{ type: 'text', text: 'b'.repeat(300) }] }),
        msg({ id: '3', role: 'user', parts: [{ type: 'text', text: 'c'.repeat(300) }] }),
      ],
      700,
    );
    expect(small).toMatch(/^\[1 earlier messages omitted for length\]/);
    expect(small).not.toContain('aaaa');
  });
});

describe('ChatService context usage and compact', () => {
  let db: Database;
  let profiles: ServerProfileRepository;
  let conversations: ConversationRepository;
  let messages: MessageRepository;
  let server: MockServer | null = null;
  let events: ChatRunEvent[];
  let settings: Record<string, unknown>;
  let service: ChatService;

  beforeEach(() => {
    db = openDatabase({ path: ':memory:' });
    profiles = new ServerProfileRepository(db);
    conversations = new ConversationRepository(db);
    messages = new MessageRepository(db);
    events = [];
    settings = { 'titles.auto': false };
    service = new ChatService({
      profiles,
      conversations,
      messages,
      tools: new ToolRegistry(db),
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

  /** 通常の質問には usage 付きで答え、要約依頼には固定の要約を返すモック */
  async function startServer() {
    server = await startMockServer({
      'POST /v1/chat/completions': (_r, body, res) => {
        const b = body as { messages: { role: string; content: string }[] };
        const last = b.messages.at(-1)!;
        if (typeof last.content === 'string' && last.content.includes('You are compacting')) {
          sse(res, [
            { choices: [{ delta: { content: 'SUMMARY of the chat' }, finish_reason: 'stop' }] },
          ]);
          return;
        }
        sse(res, [
          { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] },
          { choices: [], usage: { prompt_tokens: 900, completion_tokens: 100 } },
        ]);
      },
    });
    const p = profiles.create({
      name: 'l',
      kind: 'llamacpp',
      baseUrl: server.url,
      apiKey: null,
      defaultModel: 'm',
      defaultParams: { contextLength: 2000 },
      capabilityOverrides: { tools: false },
      modelManagement: { autoLoad: false, unloadOthers: false },
    });
    return conversations.create({ serverProfileId: p.id, model: null });
  }

  it('reports usage from the last response plus an estimate for later messages', async () => {
    const conv = await startServer();
    const empty = await service.contextUsage(conv.id);
    expect(empty).toMatchObject({
      measured: null,
      limit: 2000,
      limitSource: 'params',
      compacted: false,
    });

    const h = await service.send({ conversationId: conv.id, text: 'hello there' });
    await service.waitFor(h.runId);
    const u = await service.contextUsage(conv.id);
    expect(u.measured).toBe(1000);
    expect(u.estimated).toBe(0);
    expect(u.used).toBe(1000);
    expect(u.messagesInContext).toBe(2);
  });

  it('compacts into a summary node, sends only the summary afterwards, and keeps the old branch usable', async () => {
    const conv = await startServer();
    await expect(service.compact(conv.id)).rejects.toThrow(/要約する/);
    for (const t of ['first question', 'second question']) {
      const h = await service.send({ conversationId: conv.id, text: t });
      await service.waitFor(h.runId);
    }
    const before = conversations.get(conv.id)!.activeLeafId!;
    const { messageId } = await service.compact(conv.id);
    const node = messages.get(messageId)!;
    expect(node).toMatchObject({ kind: 'compaction', role: 'user', parentId: before });
    expect(node.parts[0]).toEqual({ type: 'text', text: 'SUMMARY of the chat' });
    expect(conversations.get(conv.id)!.activeLeafId).toBe(messageId);
    const u = await service.contextUsage(conv.id);
    expect(u).toMatchObject({ measured: null, compacted: true, messagesInContext: 0 });
    expect(u.estimated).toBeGreaterThan(0);

    // 要約後の送信: system に要約、履歴は新しい質問だけ
    const h = await service.send({ conversationId: conv.id, text: 'third question' });
    await service.waitFor(h.runId);
    const req = chatRequests(server!).at(-1)!.body as {
      messages: { role: string; content: string }[];
    };
    expect(req.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(req.messages[0]!.content).toContain('SUMMARY of the chat');
    expect(req.messages[1]!.content).toBe('third question');

    // 圧縮前の位置から分岐すると、要約は含まれず元の履歴が全部送られる
    const h2 = await service.send({ conversationId: conv.id, text: 'branch', parentId: before });
    await service.waitFor(h2.runId);
    const req2 = chatRequests(server!).at(-1)!.body as { messages: { role: string }[] };
    expect(req2.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ]);
  });

  it('auto-compacts before sending when over the threshold', async () => {
    const conv = await startServer();
    for (const t of ['first question', 'second question']) {
      const h = await service.send({ conversationId: conv.id, text: t });
      await service.waitFor(h.runId);
    }
    settings['context.autoCompact'] = true;
    settings['context.compactThreshold'] = 40; // 1000 / 2000 = 50% > 40%
    const h = await service.send({ conversationId: conv.id, text: 'third' });
    await service.waitFor(h.runId);
    const path = messages.pathToRoot(conversations.get(conv.id)!.activeLeafId!);
    expect(path.map((m) => m.kind)).toEqual([
      'normal',
      'normal',
      'normal',
      'normal',
      'compaction',
      'normal',
      'normal',
    ]);
    expect(
      events
        .filter((e) => e.event.type === 'compacting')
        .map((e) => (e.event as { state: string }).state),
    ).toEqual(['start', 'done']);
    const req = chatRequests(server!).at(-1)!.body as { messages: { role: string }[] };
    expect(req.messages.map((m) => m.role)).toEqual(['system', 'user']);
  });
});

import { describe, expect, it } from 'vitest';
import type { Conversation, Message, ServerProfile } from '@shared/schemas';
import { guessFromModelName } from '@main/providers';
import { buildChatRequest } from './message-builder';

const profile: ServerProfile = {
  id: 'p',
  name: 'p',
  kind: 'ollama',
  baseUrl: 'http://h:11434',
  apiKey: null,
  defaultModel: 'qwen3:8b',
  defaultParams: { contextLength: 8192, temperature: 0.7 },
  capabilityOverrides: {},
  createdAt: 0,
  updatedAt: 0,
};

const conversation: Conversation = {
  id: 'c',
  title: '',
  pinned: false,
  serverProfileId: 'p',
  model: null,
  systemPrompt: '  丁寧に答えて  ',
  params: { temperature: 0.2 },
  enabledTools: null,
  activeLeafId: null,
  createdAt: 0,
  updatedAt: 0,
};

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

describe('buildChatRequest', () => {
  it('merges params, prepends the system prompt and drops reasoning by default', async () => {
    const req = await buildChatRequest({
      conversation,
      profile,
      capabilities: guessFromModelName('ollama', 'qwen3:8b'),
      path: [
        msg({
          id: '1',
          role: 'user',
          parts: [
            { type: 'text', text: 'hi' },
            { type: 'image', attachmentId: 'a1', name: 'cat.png' },
          ],
        }),
        msg({
          id: '2',
          role: 'assistant',
          parts: [
            { type: 'reasoning', text: 'think' },
            { type: 'text', text: 'hello' },
          ],
        }),
        msg({ id: '3', role: 'assistant', parts: [], error: 'boom', finishReason: 'error' }),
        msg({ id: '4', role: 'user', parts: [{ type: 'text', text: 'more' }] }),
      ],
    });
    expect(req.model).toBe('qwen3:8b');
    expect(req.params).toEqual({ contextLength: 8192, temperature: 0.2 });
    expect(req.messages).toEqual([
      { role: 'system', text: '丁寧に答えて' },
      { role: 'user', text: 'hi\n[添付画像: cat.png]' },
      { role: 'assistant', text: 'hello' },
      { role: 'user', text: 'more' },
    ]);
  });

  it('includes reasoning when asked and fails without a model', async () => {
    const req = await buildChatRequest({
      conversation,
      profile,
      sendReasoning: true,
      capabilities: guessFromModelName('ollama', 'qwen3:8b'),
      path: [
        msg({
          id: '2',
          role: 'assistant',
          parts: [
            { type: 'reasoning', text: 'think' },
            { type: 'text', text: 'hello' },
          ],
        }),
      ],
    });
    expect(req.messages[1]).toEqual({ role: 'assistant', text: 'hello', reasoning: 'think' });
    await expect(
      buildChatRequest({
        conversation,
        profile: { ...profile, defaultModel: null },
        capabilities: guessFromModelName('ollama', 'x'),
        path: [],
      }),
    ).rejects.toThrow(/モデル/);
  });
});

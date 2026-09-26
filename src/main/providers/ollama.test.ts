import { afterEach, describe, expect, it } from 'vitest';
import type { ChatEvent } from '@shared/schemas';
import { OllamaAdapter } from './ollama';
import { json, ndjson, startMockServer, type MockServer } from './test-server';
import { guessFromModelName } from './capabilities';

let server: MockServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

async function collect(it: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe('OllamaAdapter', () => {
  it('lists models from /api/tags and describes them via /api/show', async () => {
    server = await startMockServer({
      'GET /api/tags': (_r, _b, res) =>
        json(res, {
          models: [{ name: 'qwen3:8b', model: 'qwen3:8b', size: 5, details: { family: 'qwen3' } }],
        }),
      'POST /api/show': (_r, _b, res) =>
        json(res, {
          capabilities: ['completion', 'tools', 'thinking'],
          model_info: { 'qwen3.context_length': 40960 },
          details: { family: 'qwen3' },
        }),
    });
    const adapter = new OllamaAdapter();
    const models = await adapter.listModels(server.profile('ollama'));
    expect(models).toEqual([
      { id: 'qwen3:8b', name: 'qwen3:8b', details: { family: 'qwen3', size: 5 } },
    ]);
    const info = await adapter.describeModel(server.profile('ollama'), 'qwen3:8b');
    expect(info).toEqual({
      id: 'qwen3:8b',
      name: 'qwen3:8b',
      contextLength: 40960,
      capabilities: { image: false, tools: true, reasoning: true },
      details: { family: 'qwen3' },
    });
  });

  it('streams NDJSON with thinking, content, tool calls and usage', async () => {
    server = await startMockServer({
      'POST /api/chat': (_r, _b, res) =>
        ndjson(res, [
          { message: { role: 'assistant', content: '', thinking: 'hmm' }, done: false },
          { message: { role: 'assistant', content: 'Hi' }, done: false },
          {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ function: { name: 'f', arguments: { a: 1 } } }],
            },
            done: false,
          },
          {
            message: { role: 'assistant', content: '' },
            done: true,
            done_reason: 'stop',
            prompt_eval_count: 5,
            eval_count: 3,
            eval_duration: 2_000_000,
          },
        ]),
    });
    const adapter = new OllamaAdapter();
    const events = await collect(
      adapter.chat(
        server.profile('ollama'),
        {
          model: 'qwen3:8b',
          messages: [
            { role: 'system', text: 'be brief' },
            { role: 'user', text: 'hello', images: [{ mime: 'image/png', base64: 'AAAA' }] },
          ],
          params: { contextLength: 16384, temperature: 0.5, think: true },
          capabilities: guessFromModelName('ollama', 'qwen3:8b'),
        },
        new AbortController().signal,
      ),
    );
    expect(events[0]).toEqual({ type: 'reasoning-delta', text: 'hmm' });
    expect(events[1]).toEqual({ type: 'text-delta', text: 'Hi' });
    expect(events[2]).toMatchObject({ type: 'tool-call', call: { name: 'f', args: '{"a":1}' } });
    expect(events[3]).toEqual({
      type: 'usage',
      usage: { promptTokens: 5, completionTokens: 3, durationMs: 2 },
    });
    expect(events[4]).toEqual({ type: 'done', finishReason: 'tool_calls' });

    const body = server.requests[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'qwen3:8b',
      stream: true,
      think: true,
      options: { num_ctx: 16384, temperature: 0.5 },
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'hello', images: ['AAAA'] },
      ],
    });
  });

  it('does not send think to models without reasoning capability', async () => {
    server = await startMockServer({
      'POST /api/chat': (_r, _b, res) =>
        ndjson(res, [{ message: { content: 'x' }, done: true, done_reason: 'stop' }]),
    });
    await collect(
      new OllamaAdapter().chat(
        server.profile('ollama'),
        {
          model: 'llama3.1',
          messages: [],
          params: { think: true },
          capabilities: guessFromModelName('ollama', 'llama3.1'),
        },
        new AbortController().signal,
      ),
    );
    expect(server.requests[0]?.body).not.toHaveProperty('think');
  });

  it('turns an error chunk into an error event', async () => {
    server = await startMockServer({
      'POST /api/chat': (_r, _b, res) =>
        ndjson(res, [{ error: 'model requires more system memory' }]),
    });
    const events = await collect(
      new OllamaAdapter().chat(
        server.profile('ollama'),
        {
          model: 'big',
          messages: [],
          params: {},
          capabilities: guessFromModelName('ollama', 'big'),
        },
        new AbortController().signal,
      ),
    );
    expect(events).toEqual([{ type: 'error', message: 'model requires more system memory' }]);
  });
});

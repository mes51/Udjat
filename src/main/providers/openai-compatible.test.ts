import { afterEach, describe, expect, it } from 'vitest';
import type { ChatEvent } from '@shared/schemas';
import { OpenAICompatibleAdapter } from './openai-compatible';
import { normalizeBaseUrl } from './http';
import { json, sse, startMockServer, type MockServer } from './test-server';
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

describe('normalizeBaseUrl', () => {
  it('strips trailing slashes and /v1', () => {
    expect(normalizeBaseUrl('http://h:8080/')).toBe('http://h:8080');
    expect(normalizeBaseUrl('http://h:8080/v1')).toBe('http://h:8080');
    expect(normalizeBaseUrl('http://h:8080/v1/')).toBe('http://h:8080');
    expect(normalizeBaseUrl('http://h:1234/api')).toBe('http://h:1234/api');
  });
});

describe('OpenAICompatibleAdapter', () => {
  it('lists models and enriches from /props on llama.cpp', async () => {
    server = await startMockServer({
      'GET /v1/models': (_r, _b, res) =>
        json(res, { data: [{ id: 'qwen3-vl', meta: { n_ctx_train: 32768 } }] }),
      'GET /props': (_r, _b, res) =>
        json(res, {
          default_generation_settings: { n_ctx: 8192 },
          modalities: { vision: true, audio: false },
        }),
    });
    const models = await new OpenAICompatibleAdapter('llamacpp').listModels(
      server.profile('llamacpp'),
    );
    expect(models).toEqual([
      {
        id: 'qwen3-vl',
        name: 'qwen3-vl',
        contextLength: 8192,
        details: { n_ctx_train: 32768 },
        capabilities: { image: true, audio: false },
      },
    ]);
  });

  it('reads llama.cpp capabilities from models[] and shortens path-like ids', async () => {
    const id = 'C:\\Users\\m\\.cache\\models--x\\gemma-4-E4B-it-Q8_0.gguf';
    server = await startMockServer({
      'GET /v1/models': (_r, _b, res) =>
        json(res, {
          data: [{ id, meta: { n_ctx_train: 131072 } }],
          models: [{ name: id, model: id, capabilities: ['completion', 'multimodal'] }],
        }),
      'GET /props': (_r, _b, res) => json(res, { default_generation_settings: { n_ctx: 8192 } }),
    });
    const models = await new OpenAICompatibleAdapter('llamacpp').listModels(
      server.profile('llamacpp'),
    );
    expect(models[0]).toMatchObject({
      id,
      name: 'gemma-4-E4B-it-Q8_0.gguf',
      contextLength: 8192,
      capabilities: { image: true },
    });
  });

  it('streams text, reasoning, usage and finish reason', async () => {
    server = await startMockServer({
      'POST /v1/chat/completions': (_r, _b, res) =>
        sse(res, [
          { choices: [{ delta: { reasoning_content: 'thinking…' } }] },
          { choices: [{ delta: { content: 'Hel' } }] },
          { choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] },
          {
            choices: [],
            usage: { prompt_tokens: 10, completion_tokens: 2 },
            timings: { predicted_ms: 40 },
          },
        ]),
    });
    const adapter = new OpenAICompatibleAdapter('llamacpp');
    const events = await collect(
      adapter.chat(
        server.profile('llamacpp'),
        {
          model: 'm',
          messages: [{ role: 'user', text: 'hi' }],
          params: { temperature: 0.2, topK: 40, think: false },
          capabilities: guessFromModelName('llamacpp', 'm'),
        },
        new AbortController().signal,
      ),
    );
    expect(events).toEqual([
      { type: 'reasoning-delta', text: 'thinking…' },
      { type: 'text-delta', text: 'Hel' },
      { type: 'text-delta', text: 'lo' },
      { type: 'usage', usage: { promptTokens: 10, completionTokens: 2, durationMs: 40 } },
      { type: 'done', finishReason: 'stop' },
    ]);
    const body = server.requests[0]?.body as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'm',
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.2,
      top_k: 40,
      reasoning_budget: 0,
      messages: [{ role: 'user', content: 'hi' }],
    });
  });

  it('assembles streamed tool calls by index', async () => {
    server = await startMockServer({
      'POST /v1/chat/completions': (_r, _b, res) =>
        sse(res, [
          {
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: 'call_1',
                      function: { name: 'video_info', arguments: '{"vid' },
                    },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              { delta: { tool_calls: [{ index: 0, function: { arguments: 'eo_id":"v1"}' } }] } },
            ],
          },
          { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
        ]),
    });
    const adapter = new OpenAICompatibleAdapter('vllm');
    const events = await collect(
      adapter.chat(
        server.profile('vllm'),
        {
          model: 'm',
          messages: [{ role: 'user', text: 'x' }],
          params: {},
          capabilities: guessFromModelName('vllm', 'm'),
        },
        new AbortController().signal,
      ),
    );
    expect(events[0]).toEqual({
      type: 'tool-call',
      call: { id: 'call_1', name: 'video_info', args: '{"video_id":"v1"}' },
    });
    expect(events.at(-1)).toEqual({ type: 'done', finishReason: 'tool_calls' });
  });

  it('sends images as image_url parts and videos per dialect', async () => {
    server = await startMockServer({
      'POST /v1/chat/completions': (_r, _b, res) =>
        sse(res, [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
    });
    const msg = {
      role: 'user' as const,
      text: 'see',
      images: [{ mime: 'image/png', base64: 'AAAA' }],
      video: [{ mime: 'video/mp4', base64: 'BBBB' }],
    };
    for (const kind of ['llamacpp', 'vllm'] as const) {
      await collect(
        new OpenAICompatibleAdapter(kind).chat(
          server.profile(kind),
          {
            model: 'm',
            messages: [msg],
            params: {},
            capabilities: guessFromModelName(kind, 'qwen3-vl'),
          },
          new AbortController().signal,
        ),
      );
    }
    const [a, b] = server.requests.map(
      (r) => (r.body as { messages: { content: unknown[] }[] }).messages[0]!.content,
    );
    expect(a).toEqual([
      { type: 'text', text: 'see' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
      { type: 'input_video', input_video: { data: 'BBBB' } },
    ]);
    expect(b?.[2]).toEqual({ type: 'video_url', video_url: { url: 'data:video/mp4;base64,BBBB' } });
  });

  it('surfaces HTTP errors with the response body', async () => {
    server = await startMockServer({
      'POST /v1/chat/completions': (_r, _b, res) =>
        json(res, { error: { message: 'model not found' } }, 404),
    });
    const adapter = new OpenAICompatibleAdapter('lmstudio');
    await expect(
      collect(
        adapter.chat(
          server.profile('lmstudio'),
          {
            model: 'nope',
            messages: [],
            params: {},
            capabilities: guessFromModelName('lmstudio', 'nope'),
          },
          new AbortController().signal,
        ),
      ),
    ).rejects.toThrow(/404.*model not found/);
  });

  it('stops when aborted mid-stream', async () => {
    server = await startMockServer({
      'POST /v1/chat/completions': (_r, _b, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'first' } }] })}\n\n`);
        // 以降は送らずに開けたままにする
        const t = setInterval(() => res.write(': keepalive\n\n'), 50);
        res.on('close', () => clearInterval(t));
      },
    });
    const ac = new AbortController();
    const adapter = new OpenAICompatibleAdapter('openai-compatible');
    const got: ChatEvent[] = [];
    const run = (async () => {
      for await (const e of adapter.chat(
        server!.profile('openai-compatible'),
        {
          model: 'm',
          messages: [],
          params: {},
          capabilities: guessFromModelName('openai-compatible', 'm'),
        },
        ac.signal,
      )) {
        got.push(e);
        if (e.type === 'text-delta') ac.abort();
      }
    })();
    await expect(run).rejects.toThrow();
    expect(got).toEqual([{ type: 'text-delta', text: 'first' }]);
  });
});

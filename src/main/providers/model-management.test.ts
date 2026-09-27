import { afterEach, describe, expect, it } from 'vitest';
import { modelManagerFor } from './model-management';
import { OpenAICompatibleAdapter } from './openai-compatible';
import { json, startMockServer, type MockServer } from './test-server';

let server: MockServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe('model management', () => {
  it('has managers only for unsloth / llamacpp / lmstudio', () => {
    expect(modelManagerFor('unsloth')).toBeDefined();
    expect(modelManagerFor('llamacpp')).toBeDefined();
    expect(modelManagerFor('lmstudio')).toBeDefined();
    expect(modelManagerFor('vllm')).toBeUndefined();
    expect(modelManagerFor('ollama')).toBeUndefined();
    expect(modelManagerFor('openai-compatible')).toBeUndefined();
    expect(new OpenAICompatibleAdapter('unsloth').models).toBeDefined();
    expect(new OpenAICompatibleAdapter('vllm').models).toBeUndefined();
  });

  it('unsloth: reads loaded flags from /v1/models and loads/unloads via /v1/load /v1/unload', async () => {
    let resident = 'a';
    server = await startMockServer({
      'GET /v1/models': (_r, _b, res) =>
        json(res, {
          data: [
            { id: 'a', object: 'model', loaded: resident === 'a', quant: 'Q4_K_M' },
            { id: 'b', object: 'model', loaded: resident === 'b' },
          ],
        }),
      'POST /v1/load': (_r, body, res) => {
        resident = (body as { model_path: string }).model_path;
        json(res, { status: 'loaded', model: resident, display_name: resident, inference: {} });
      },
      'POST /v1/unload': (_r, body, res) => {
        if (resident === (body as { model_path: string }).model_path) resident = '';
        json(res, { status: 'unloaded' });
      },
    });
    const profile = server.profile('unsloth');
    const mgr = modelManagerFor('unsloth')!;
    // 常駐中の量子化は "id:QUANT" でも一致する
    expect(await mgr.status(profile)).toEqual({
      supported: true,
      loaded: ['a', 'a:Q4_K_M'],
      loading: [],
    });
    // listModels にも loaded が入る(gguf-variants が無いサーバーでは素の行のまま)
    const models = await new OpenAICompatibleAdapter('unsloth').listModels(profile);
    expect(models.map((m) => [m.id, m.loaded])).toEqual([
      ['a', true],
      ['b', false],
    ]);
    await mgr.load(profile, 'b');
    const loadReq = () => server!.requests.filter((r) => r.path === '/v1/load').at(-1)?.body;
    expect(loadReq()).toEqual({ model_path: 'b', max_seq_length: 0 });
    expect((await mgr.status(profile)).loaded).toEqual(['b']);
    // GGUF は /v1/models の quant を gguf_variant として渡す(無いと Transformers ロード扱いになる)
    await mgr.load(profile, 'a');
    expect(loadReq()).toEqual({ model_path: 'a', max_seq_length: 0, gguf_variant: 'Q4_K_M' });
    // "id:QUANT" 形式でも指定できる
    await mgr.load(profile, 'b:Q8_0');
    expect(loadReq()).toEqual({ model_path: 'b', max_seq_length: 0, gguf_variant: 'Q8_0' });
    await mgr.unload(profile, 'b');
    expect(server.requests.at(-1)?.body).toEqual({ model_path: 'b' });
    expect((await mgr.status(profile)).loaded).toEqual([]);
  });

  it('unsloth: expands GGUF rows into downloaded quantizations and sends the bare id to chat', async () => {
    server = await startMockServer({
      'GET /v1/models': (_r, _b, res) =>
        json(res, {
          data: [
            { id: 'org/gemma-GGUF', object: 'model', loaded: true, quant: 'Q8_0' },
            { id: 'org/plain-model', object: 'model', loaded: false },
          ],
        }),
      'GET /api/models/gguf-variants?repo_id=org%2Fgemma-GGUF&prefer_local_cache=true&offline=true':
        (_r, _b, res) =>
          json(res, {
            repo_id: 'org/gemma-GGUF',
            variants: [
              { filename: 'a-Q4_K_M.gguf', quant: 'Q4_K_M', downloaded: true, size_bytes: 10 },
              { filename: 'a-Q8_0.gguf', quant: 'Q8_0', downloaded: true, size_bytes: 20 },
              { filename: 'a-BF16.gguf', quant: 'BF16', downloaded: false, size_bytes: 40 },
            ],
            default_variant: 'Q4_K_M',
          }),
      'POST /v1/chat/completions': (_r, body, res) =>
        json(res, { echo: (body as { model: string }).model }),
    });
    const profile = server.profile('unsloth');
    const adapter = new OpenAICompatibleAdapter('unsloth');
    const models = await adapter.listModels(profile);
    expect(models.map((m) => [m.id, m.name, m.loaded])).toEqual([
      ['org/gemma-GGUF:Q4_K_M', 'gemma-GGUF (Q4_K_M)', false],
      ['org/gemma-GGUF:Q8_0', 'gemma-GGUF (Q8_0)', true],
      ['org/plain-model', 'plain-model', false],
    ]);
    // "id:QUANT" を選んでもチャットには素の id を送る
    const it = adapter.chat(
      profile,
      {
        model: 'org/gemma-GGUF:Q4_K_M',
        messages: [{ role: 'user', text: 'hi' }],
        params: {},
        capabilities: {
          image: false,
          audio: false,
          video: 'none',
          tools: false,
          streamingToolCalls: false,
          toolResultMedia: 'follow-up-user-message',
          reasoning: false,
        },
      },
      new AbortController().signal,
    );
    for await (const _ev of it) {
      /* JSON 応答なので特に読まない */
    }
    const chatReq = server.requests.find((r) => r.path === '/v1/chat/completions');
    expect((chatReq?.body as { model: string }).model).toBe('org/gemma-GGUF');
    // ロードは選んだ量子化で行う
    await modelManagerFor('unsloth')!
      .load(profile, 'org/gemma-GGUF:Q4_K_M')
      .catch(() => undefined);
    const loadReq = server.requests.find((r) => r.path === '/v1/load');
    expect(loadReq?.body).toEqual({
      model_path: 'org/gemma-GGUF',
      max_seq_length: 0,
      gguf_variant: 'Q4_K_M',
    });
  });

  it('unsloth: treats a padded _deferred_error body and a no-op 200 as failures', async () => {
    let mode: 'deferred' | 'noop' = 'deferred';
    server = await startMockServer({
      'GET /v1/models': (_r, _b, res) =>
        json(res, { data: [{ id: 'm', object: 'model', loaded: false, quant: 'Q8_0' }] }),
      'POST /v1/load': (_r, _b, res) => {
        if (mode === 'deferred') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.write('   ');
          res.end(
            JSON.stringify({ _deferred_error: { status_code: 500, detail: 'CUDA out of memory' } }),
          );
        } else json(res, { status: 'loaded', model: 'm' });
      },
    });
    const profile = server.profile('unsloth');
    const mgr = modelManagerFor('unsloth')!;
    await expect(mgr.load(profile, 'm')).rejects.toThrow(/CUDA out of memory/);
    mode = 'noop';
    await expect(mgr.load(profile, 'm')).rejects.toThrow(/常駐していません/);
  });

  it('llama.cpp router: uses /models status and polls until loaded; single-model mode is unsupported', async () => {
    const state: Record<string, string> = { x: 'unloaded', y: 'loaded' };
    let polls = 0;
    server = await startMockServer({
      'GET /models': (_r, _b, res) => {
        polls++;
        // 2 回目の問い合わせでロード完了にする
        if (state['x'] === 'loading' && polls > 2) state['x'] = 'loaded';
        json(res, { data: Object.entries(state).map(([id, s]) => ({ id, status: { value: s } })) });
      },
      'POST /models/load': (_r, body, res) => {
        state[(body as { model: string }).model] = 'loading';
        json(res, { success: true });
      },
      'POST /models/unload': (_r, body, res) => {
        state[(body as { model: string }).model] = 'unloaded';
        json(res, { success: true });
      },
    });
    const profile = server.profile('llamacpp');
    const mgr = modelManagerFor('llamacpp')!;
    expect(await mgr.status(profile)).toEqual({ supported: true, loaded: ['y'], loading: [] });
    await mgr.load(profile, 'x');
    expect(state['x']).toBe('loaded');
    await mgr.unload(profile, 'y');
    expect((await mgr.status(profile)).loaded).toEqual(['x']);
    await server.close();

    // 単一モデル起動: status が無い
    server = await startMockServer({
      'GET /models': (_r, _b, res) => json(res, { data: [{ id: 'single', object: 'model' }] }),
    });
    expect(await mgr.status(server.profile('llamacpp'))).toEqual({
      supported: false,
      loaded: [],
      loading: [],
    });
  });

  it('lm studio: reads loaded_instances and unloads by instance id', async () => {
    const instances: Record<string, string[]> = {
      'org/model-a': ['org/model-a'],
      'org/model-b': [],
    };
    server = await startMockServer({
      'GET /api/v1/models': (_r, _b, res) =>
        json(res, {
          models: Object.entries(instances).map(([key, ids]) => ({
            type: 'llm',
            key,
            loaded_instances: ids.map((id) => ({ id, config: {} })),
          })),
        }),
      'POST /api/v1/models/load': (_r, body, res) => {
        const key = (body as { model: string }).model;
        instances[key] = [`${key}:2`];
        json(res, { type: 'llm', instance_id: `${key}:2`, status: 'loaded' });
      },
      'POST /api/v1/models/unload': (_r, body, res) => {
        const id = (body as { instance_id: string }).instance_id;
        for (const k of Object.keys(instances))
          instances[k] = (instances[k] ?? []).filter((x) => x !== id);
        json(res, { instance_id: id });
      },
    });
    const profile = server.profile('lmstudio');
    const mgr = modelManagerFor('lmstudio')!;
    expect((await mgr.status(profile)).loaded).toEqual(['org/model-a']);
    await mgr.load(profile, 'org/model-b');
    expect((await mgr.status(profile)).loaded).toEqual([
      'org/model-a',
      'org/model-b',
      'org/model-b:2',
    ]);
    await mgr.unload(profile, 'org/model-b');
    expect(server.requests.at(-1)?.body).toEqual({ instance_id: 'org/model-b:2' });
    expect((await mgr.status(profile)).loaded).toEqual(['org/model-a']);
  });
});

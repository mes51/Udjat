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
    expect(await mgr.status(profile)).toEqual({ supported: true, loaded: ['a'], loading: [] });
    // listModels にも loaded が入る
    const models = await new OpenAICompatibleAdapter('unsloth').listModels(profile);
    expect(models.map((m) => [m.id, m.loaded])).toEqual([
      ['a', true],
      ['b', false],
    ]);
    await mgr.load(profile, 'b');
    expect(server.requests.at(-1)?.body).toEqual({ model_path: 'b', max_seq_length: 0 });
    expect((await mgr.status(profile)).loaded).toEqual(['b']);
    await mgr.unload(profile, 'b');
    expect((await mgr.status(profile)).loaded).toEqual([]);
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

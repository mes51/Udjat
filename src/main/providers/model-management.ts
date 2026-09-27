import type { ServerKind, ServerProfile } from '@shared/schemas';
import { requestJson } from './http';
import { ProviderError, type ModelManager } from './types';

/**
 * サーバー側のモデルロード/アンロード(M10)。API は docs/plan/07-feedback-round-1.md の表を参照。
 *
 * - Unsloth Studio: GET /v1/models の loaded フラグ、POST /v1/load { model_path }、POST /v1/unload { model_path }
 * - llama.cpp router: GET /models の status、POST /models/load { model }、POST /models/unload { model }
 * - LM Studio:       GET /api/v1/models の loaded_instances、POST /api/v1/models/load { model }、
 *                    POST /api/v1/models/unload { instance_id }
 */

/** ロードは大きい GGUF で分単位かかるので長めに待つ */
export const LOAD_TIMEOUT_MS = 10 * 60_000;
const STATUS_TIMEOUT_MS = 8_000;

function statusValue(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && typeof (v as { value?: unknown }).value === 'string')
    return (v as { value: string }).value;
  return null;
}

const unsloth: ModelManager = {
  async status(profile, signal) {
    const res = await requestJson<{ data?: { id: string; loaded?: boolean }[] }>(
      profile,
      '/v1/models',
      { signal, timeoutMs: STATUS_TIMEOUT_MS },
    );
    const rows = res.data ?? [];
    return {
      supported: rows.some((r) => typeof r.loaded === 'boolean'),
      loaded: rows.filter((r) => r.loaded === true).map((r) => r.id),
      loading: [],
    };
  },
  async load(profile, model, signal) {
    // model_path は /v1/models の id(公開 id)。max_seq_length 0 = サーバーに任せる
    await requestJson<{ status?: string; model?: string }>(profile, '/v1/load', {
      method: 'POST',
      body: { model_path: model, max_seq_length: 0 },
      signal,
      timeoutMs: LOAD_TIMEOUT_MS,
    });
  },
  async unload(profile, model, signal) {
    await requestJson(profile, '/v1/unload', {
      method: 'POST',
      body: { model_path: model },
      signal,
      timeoutMs: 3 * 60_000,
    });
  },
};

const llamacppRouter: ModelManager = {
  async status(profile, signal) {
    const res = await requestJson<{ data?: { id: string; status?: unknown }[] }>(
      profile,
      '/models',
      { signal, timeoutMs: STATUS_TIMEOUT_MS },
    );
    const rows = (res.data ?? []).map((r) => ({ id: r.id, status: statusValue(r.status) }));
    return {
      // 単一モデル起動(-m)では status が無いので非対応扱い
      supported: rows.some((r) => r.status !== null),
      loaded: rows.filter((r) => r.status === 'loaded').map((r) => r.id),
      loading: rows.filter((r) => r.status === 'loading').map((r) => r.id),
    };
  },
  async load(profile, model, signal) {
    await requestJson(profile, '/models/load', {
      method: 'POST',
      body: { model },
      signal,
      timeoutMs: LOAD_TIMEOUT_MS,
    });
    // router はロード要求を受けた時点で返ることがあるので、loaded になるまで待つ
    await waitUntilLoaded(this, profile, model, signal);
  },
  async unload(profile, model, signal) {
    await requestJson(profile, '/models/unload', {
      method: 'POST',
      body: { model },
      signal,
      timeoutMs: 60_000,
    });
  },
};

interface LmStudioModel {
  key: string;
  loaded_instances?: { id: string }[];
}

async function lmStudioModels(profile: ServerProfile, signal?: AbortSignal) {
  const res = await requestJson<{ models?: LmStudioModel[] }>(profile, '/api/v1/models', {
    signal,
    timeoutMs: STATUS_TIMEOUT_MS,
  });
  return res.models ?? [];
}

const lmstudio: ModelManager = {
  async status(profile, signal) {
    const models = await lmStudioModels(profile, signal);
    const loaded: string[] = [];
    for (const m of models) {
      if ((m.loaded_instances ?? []).length === 0) continue;
      loaded.push(m.key);
      for (const inst of m.loaded_instances ?? []) if (inst.id !== m.key) loaded.push(inst.id);
    }
    return { supported: true, loaded, loading: [] };
  },
  async load(profile, model, signal) {
    await requestJson<{ instance_id?: string; status?: string }>(profile, '/api/v1/models/load', {
      method: 'POST',
      body: { model },
      signal,
      timeoutMs: LOAD_TIMEOUT_MS,
    });
  },
  async unload(profile, model, signal) {
    // unload は instance_id 指定。モデルキーで指定された時は常駐インスタンスを引く
    const models = await lmStudioModels(profile, signal);
    const ids = new Set<string>();
    for (const m of models) {
      for (const inst of m.loaded_instances ?? []) {
        if (m.key === model || inst.id === model) ids.add(inst.id);
      }
    }
    if (ids.size === 0) ids.add(model);
    for (const instance_id of ids) {
      await requestJson(profile, '/api/v1/models/unload', {
        method: 'POST',
        body: { instance_id },
        signal,
        timeoutMs: 60_000,
      });
    }
  },
};

async function waitUntilLoaded(
  manager: ModelManager,
  profile: ServerProfile,
  model: string,
  signal: AbortSignal | undefined,
  timeoutMs = LOAD_TIMEOUT_MS,
): Promise<void> {
  const t0 = Date.now();
  for (;;) {
    const s = await manager.status(profile, signal);
    if (s.loaded.includes(model)) return;
    if (!s.loading.includes(model)) {
      throw new ProviderError(`モデル ${model} のロードがサーバーで始まりませんでした`);
    }
    if (Date.now() - t0 > timeoutMs) {
      throw new ProviderError(`モデル ${model} のロードがタイムアウトしました`);
    }
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, 1000);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(t);
          reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        },
        { once: true },
      );
    });
  }
}

export function modelManagerFor(kind: ServerKind): ModelManager | undefined {
  switch (kind) {
    case 'unsloth':
      return unsloth;
    case 'llamacpp':
      return llamacppRouter;
    case 'lmstudio':
      return lmstudio;
    default:
      return undefined;
  }
}

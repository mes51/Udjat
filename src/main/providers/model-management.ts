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

interface UnslothModelRow {
  id: string;
  loaded?: boolean;
  /** GGUF の量子化(Q4_K_M 等)。無ければ Transformers / MLX のモデル */
  quant?: string;
}

async function unslothModels(profile: ServerProfile, signal?: AbortSignal) {
  const res = await requestJson<{ data?: UnslothModelRow[] }>(profile, '/v1/models', {
    signal,
    timeoutMs: STATUS_TIMEOUT_MS,
  });
  return res.data ?? [];
}

/** Unsloth の GGUF 量子化候補(ダウンロード済みのもの) */
export interface UnslothVariant {
  quant: string;
  label: string;
  downloaded: boolean;
  sizeBytes: number;
}

/** 量子化名らしい文字列か(Q4_K_M, IQ2_XS, UD-Q4_K_XL, BF16, F16, MXFP4 など)。Ollama タグ等の誤分解を避ける */
export function looksLikeQuant(s: string): boolean {
  return /^(ud-)?(i?qd|f16|f32|bf16|mxfpd|tqd)[a-z0-9_.-]*$/i.test(s);
}

/** "repo:QUANT" を分解する。rows に repo があるか、末尾が量子化名らしい時だけ分ける */
export function splitUnslothModel(
  rows: readonly { id: string }[],
  model: string,
): { id: string; quant?: string } {
  if (rows.some((r) => r.id === model) || !model.includes(':')) return { id: model };
  const i = model.lastIndexOf(':');
  const base = model.slice(0, i);
  const suffix = model.slice(i + 1);
  if (rows.some((r) => r.id === base) || looksLikeQuant(suffix)) return { id: base, quant: suffix };
  return { id: model };
}

/**
 * GET /api/models/gguf-variants で repo の量子化一覧を引く(オフライン・ローカル優先)。
 * /v1/models は常駐中(または先頭)の quant しか返さないので、モデル選択 UI 用に使う。
 */
export async function unslothVariants(
  profile: ServerProfile,
  repoId: string,
  signal?: AbortSignal,
): Promise<UnslothVariant[]> {
  const q = new URLSearchParams({ repo_id: repoId, prefer_local_cache: 'true', offline: 'true' });
  const res = await requestJson<{
    variants?: {
      quant: string;
      display_label?: string | null;
      downloaded?: boolean;
      size_bytes?: number;
    }[];
  }>(profile, `/api/models/gguf-variants?${q.toString()}`, { signal, timeoutMs: 8_000 });
  return (res.variants ?? []).map((v) => ({
    quant: v.quant,
    label: v.display_label ?? v.quant,
    downloaded: v.downloaded === true,
    sizeBytes: v.size_bytes ?? 0,
  }));
}

/**
 * Unsloth の /load は GGUF を `gguf_variant` の有無で見分ける(無いと Transformers ロード扱いになり
 * GGUF は読み込まれない)。/v1/models の `quant` を渡し、"id:QUANT" 形式の指定も受け付ける。
 */
function unslothLoadBody(rows: UnslothModelRow[], model: string): Record<string, unknown> {
  const parsed = splitUnslothModel(rows, model);
  const id = parsed.id;
  const row = rows.find((r) => r.id === id);
  const quant = parsed.quant ?? row?.quant;
  // max_seq_length 0 = サーバー(llama.cpp / MLX)にコンテキスト長を任せる
  const body: Record<string, unknown> = { model_path: id, max_seq_length: 0 };
  if (quant) body['gguf_variant'] = quant;
  return body;
}

/** 15 秒を超えるロードは 200 のままパディングされた本文で返り、失敗は本文の _deferred_error に入る */
function unslothDeferredError(res: unknown): string | null {
  const d = (res as { _deferred_error?: { status_code?: number; detail?: unknown } } | null)
    ?._deferred_error;
  if (!d) return null;
  const detail = typeof d.detail === 'string' ? d.detail : JSON.stringify(d.detail);
  return `${d.status_code ?? ''} ${detail}`.trim();
}

const unsloth: ModelManager = {
  async status(profile, signal) {
    const rows = await unslothModels(profile, signal);
    return {
      supported: rows.some((r) => typeof r.loaded === 'boolean'),
      // 常駐中の量子化は "id:QUANT" でも一致させる(モデル一覧はその形で展開する)
      loaded: rows
        .filter((r) => r.loaded === true)
        .flatMap((r) => (r.quant ? [r.id, `${r.id}:${r.quant}`] : [r.id])),
      loading: [],
    };
  },
  async load(profile, model, signal) {
    const rows = await unslothModels(profile, signal);
    const body = unslothLoadBody(rows, model);
    const res = await requestJson<{ status?: string; model?: string }>(profile, '/v1/load', {
      method: 'POST',
      body,
      signal,
      timeoutMs: LOAD_TIMEOUT_MS,
    });
    const deferred = unslothDeferredError(res);
    if (deferred) throw new ProviderError(`モデルのロードに失敗しました: ${deferred}`);
    // 応答が返っても常駐していなければ失敗扱い(no-op で 200 が返るケースを拾う)
    const after = await this.status(profile, signal);
    const id = String(body['model_path']);
    if (!after.loaded.includes(id) && !after.loaded.includes(model)) {
      throw new ProviderError(
        `ロード要求は受け付けられましたが、モデル ${model} が常駐していません(応答: ${JSON.stringify(res).slice(0, 300)})`,
      );
    }
  },
  async unload(profile, model, signal) {
    const rows = await unslothModels(profile, signal);
    const body = unslothLoadBody(rows, model);
    const res = await requestJson(profile, '/v1/unload', {
      method: 'POST',
      body: { model_path: body['model_path'] },
      signal,
      timeoutMs: 3 * 60_000,
    });
    const deferred = unslothDeferredError(res);
    if (deferred) throw new ProviderError(`モデルのアンロードに失敗しました: ${deferred}`);
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

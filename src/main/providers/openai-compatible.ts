import type {
  ChatEvent,
  ChatParams,
  ModelInfo,
  ServerKind,
  ServerProfile,
  ToolCall,
} from '@shared/schemas';
import { detectReasoningFromTemplate } from './capabilities';
import { request, requestJson } from './http';
import {
  modelManagerFor,
  splitUnslothModel,
  unslothVariants,
  type UnslothVariant,
} from './model-management';
import { parseSse } from './stream-parsers';
import type { CanonicalMessage, ChatRequest, ModelManager, ProviderAdapter } from './types';

/**
 * OpenAI 互換 API(/v1/chat/completions)アダプタ。
 * llama.cpp / vLLM / LM Studio / 汎用サーバーを 1 本で扱い、方言差は kind で分岐する。
 */

type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'input_audio'; input_audio: { data: string; format: string } }
  | { type: 'input_video'; input_video: { data: string } } // llama.cpp
  | { type: 'video_url'; video_url: { url: string } }; // vLLM

interface WireMessage {
  role: string;
  content: string | ContentPart[] | null;
  reasoning_content?: string;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

interface ChunkDelta {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: {
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }[];
}

interface Chunk {
  choices?: { delta?: ChunkDelta; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  timings?: { predicted_ms?: number };
  error?: { message?: string } | string;
}

function toWireMessages(kind: ServerKind, messages: CanonicalMessage[]): WireMessage[] {
  return messages.map((m) => {
    const parts: ContentPart[] = [];
    if (m.text) parts.push({ type: 'text', text: m.text });
    for (const img of m.images ?? []) {
      parts.push({
        type: 'image_url',
        image_url: { url: `data:${img.mime};base64,${img.base64}` },
      });
    }
    for (const a of m.audio ?? []) {
      parts.push({
        type: 'input_audio',
        input_audio: { data: a.base64, format: a.mime.split('/')[1] ?? 'wav' },
      });
    }
    for (const v of m.video ?? []) {
      if (kind === 'vllm')
        parts.push({ type: 'video_url', video_url: { url: `data:${v.mime};base64,${v.base64}` } });
      else parts.push({ type: 'input_video', input_video: { data: v.base64 } });
    }
    const onlyText = parts.length === 1 && parts[0]?.type === 'text';
    const wire: WireMessage = {
      role: m.role,
      content: parts.length === 0 ? '' : onlyText ? m.text : parts,
    };
    if (m.toolCalls && m.toolCalls.length > 0) {
      wire.tool_calls = m.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.args },
      }));
      if (!m.text) wire.content = null;
    }
    if (m.toolCallId) wire.tool_call_id = m.toolCallId;
    return wire;
  });
}

/**
 * LM Studio の REST API v1(/api/v1/models)には capability(vision / tool use / reasoning の候補)があるので、
 * OpenAI 互換の一覧に重ねる。無ければ何もしない。
 */
async function mergeLmStudioCapabilities(
  profile: ServerProfile,
  models: ModelInfo[],
  signal?: AbortSignal,
): Promise<void> {
  try {
    const res = await requestJson<{
      models?: {
        key: string;
        max_context_length?: number;
        capabilities?: {
          vision?: boolean;
          trained_for_tool_use?: boolean;
          reasoning?: { allowed_options?: string[]; default?: string };
        };
      }[];
    }>(profile, '/api/v1/models', { signal, timeoutMs: 5_000 });
    const byKey = new Map((res.models ?? []).map((m) => [m.key, m] as const));
    for (const m of models) {
      const row = byKey.get(m.id);
      if (!row) continue;
      if (row.max_context_length && !m.contextLength) m.contextLength = row.max_context_length;
      const c = row.capabilities;
      if (!c) continue;
      const options = (c.reasoning?.allowed_options ?? []).filter((o) => o !== 'on' && o !== 'off');
      m.capabilities = {
        ...m.capabilities,
        ...(c.vision !== undefined ? { image: c.vision } : {}),
        ...(c.trained_for_tool_use !== undefined ? { tools: c.trained_for_tool_use } : {}),
        ...(c.reasoning ? { reasoning: true, reasoningLevels: options } : {}),
      };
    }
  } catch {
    /* v1 REST API が無い(古い LM Studio) */
  }
}

/** サーバーに渡すモデル id。Unsloth は "repo:QUANT" で選んでいても素の id で送る(量子化はロード時に決まる) */
function wireModelId(kind: ServerKind, model: string): string {
  return kind === 'unsloth' ? splitUnslothModel([], model).id : model;
}

/**
 * Unsloth: /v1/models は常駐中(または先頭)の量子化しか返さないので、GGUF の行は
 * /api/models/gguf-variants で取ったダウンロード済み量子化ごとに "repo:QUANT" へ展開する。
 * 取得に失敗した repo は素の行のまま残す。
 */
async function expandUnslothVariants(
  profile: ServerProfile,
  rows: { id: string; loaded?: boolean; quant?: string }[],
  models: ModelInfo[],
  signal?: AbortSignal,
): Promise<ModelInfo[]> {
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const expanded = await Promise.all(
    models.map(async (m) => {
      const row = byId.get(m.id);
      if (!row?.quant) return [m];
      let variants: UnslothVariant[];
      try {
        variants = (await unslothVariants(profile, m.id, signal)).filter((v) => v.downloaded);
      } catch {
        return [m];
      }
      if (variants.length === 0) return [m];
      // 常駐中の量子化が一覧に無ければ先頭に足す(quant の表記揺れ対策)
      if (row.loaded && !variants.some((v) => v.quant === row.quant))
        variants.unshift({ quant: row.quant, label: row.quant, downloaded: true, sizeBytes: 0 });
      return variants.map<ModelInfo>((v) => ({
        ...m,
        id: `${m.id}:${v.quant}`,
        name: `${m.name} (${v.label})`,
        loaded: row.loaded === true && row.quant === v.quant,
        details: { ...m.details, quant: v.quant, sizeBytes: v.sizeBytes },
      }));
    }),
  );
  return expanded.flat();
}

/**
 * 思考の ON/OFF とレベルをサーバーごとの流儀で付ける。
 * - テンプレート変数: chat_template_kwargs.enable_thinking / reasoning_effort(llama.cpp / vLLM / LM Studio / Unsloth 共通)
 * - llama.cpp: reasoning_effort "none" で無効化、それ以外の値はテンプレートに渡る。reasoning_budget も併用
 * - Unsloth: トップレベルの enable_thinking / reasoning_effort([x-unsloth])
 * - LM Studio / vLLM / 汎用: OpenAI 互換の reasoning_effort
 * 未指定(undefined)なら何も送らずサーバー既定に任せる。
 */
export function applyReasoning(
  kind: ServerKind,
  p: ChatParams,
  body: Record<string, unknown>,
): void {
  const off = p.think === false;
  const level = !off && p.reasoningEffort ? p.reasoningEffort : undefined;
  if (p.think === undefined && !level) return;
  const kwargs: Record<string, unknown> = {};
  if (p.think !== undefined) kwargs['enable_thinking'] = p.think;
  if (level) kwargs['reasoning_effort'] = level;
  body['chat_template_kwargs'] = kwargs;
  if (kind === 'llamacpp') {
    if (off) {
      body['reasoning_budget'] = 0;
      body['reasoning_effort'] = 'none';
    } else {
      body['reasoning_budget'] = -1;
      if (level) body['reasoning_effort'] = level;
    }
  } else if (kind === 'unsloth') {
    if (p.think !== undefined) body['enable_thinking'] = p.think;
    if (off) body['reasoning_effort'] = 'none';
    else if (level) body['reasoning_effort'] = level;
  } else if (level) {
    body['reasoning_effort'] = level;
  }
}

function buildBody(kind: ServerKind, req: ChatRequest): Record<string, unknown> {
  const p = req.params;
  const body: Record<string, unknown> = {
    model: wireModelId(kind, req.model),
    messages: toWireMessages(kind, req.messages),
    stream: true,
    stream_options: { include_usage: true },
  };
  if (p.temperature !== undefined) body['temperature'] = p.temperature;
  if (p.topP !== undefined) body['top_p'] = p.topP;
  if (p.maxTokens !== undefined) body['max_tokens'] = p.maxTokens;
  if (p.seed !== undefined) body['seed'] = p.seed;
  if (p.stop && p.stop.length > 0) body['stop'] = p.stop;

  // 非標準パラメータはサーバーが受け付けるものだけ送る
  if (kind === 'llamacpp' || kind === 'vllm' || kind === 'lmstudio') {
    if (p.topK !== undefined) body['top_k'] = p.topK;
    if (p.minP !== undefined) body['min_p'] = p.minP;
  }
  if (kind === 'llamacpp' || kind === 'lmstudio') {
    if (p.repeatPenalty !== undefined) body['repeat_penalty'] = p.repeatPenalty;
  }
  if (kind === 'vllm' && p.repeatPenalty !== undefined)
    body['repetition_penalty'] = p.repeatPenalty;
  applyReasoning(kind, p, body);
  if (req.tools && req.tools.length > 0 && req.capabilities.tools) {
    body['tools'] = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  return body;
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  readonly models: ModelManager | undefined;

  constructor(readonly kind: ServerKind) {
    this.models = modelManagerFor(kind);
  }

  async listModels(profile: ServerProfile, signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await requestJson<{
      data?: {
        id: string;
        meta?: { n_ctx_train?: number; n_params?: number };
        /** Unsloth: 常駐しているか */
        loaded?: boolean;
        /** llama.cpp router: "loaded" | "loading" | "unloaded"(または { value }) */
        status?: unknown;
      }[];
      /** llama.cpp は Ollama 互換の models[] も返し、capabilities(multimodal 等)が入る */
      models?: { name?: string; model?: string; capabilities?: string[] }[];
    }>(profile, '/v1/models', { signal, timeoutMs: 5_000 });
    const reported = new Map<string, string[]>();
    for (const m of res.models ?? []) {
      const key = m.model ?? m.name;
      if (key && Array.isArray(m.capabilities)) reported.set(key, m.capabilities);
    }
    const models: ModelInfo[] = (res.data ?? []).map((m) => {
      // id がファイルパスのことがある(llama.cpp)ので、表示名は末尾だけにする
      const info: ModelInfo = { id: m.id, name: m.id.split(/[\\/]/).pop() || m.id };
      if (m.meta?.n_ctx_train) info.contextLength = m.meta.n_ctx_train;
      if (m.meta) info.details = m.meta;
      if (typeof m.loaded === 'boolean') info.loaded = m.loaded;
      const st =
        typeof m.status === 'string'
          ? m.status
          : m.status && typeof m.status === 'object'
            ? (m.status as { value?: unknown }).value
            : undefined;
      if (typeof st === 'string') info.loaded = st === 'loaded';
      const caps = reported.get(m.id);
      if (caps) {
        info.capabilities = {
          image: caps.includes('multimodal') || caps.includes('vision'),
          ...(caps.includes('tools') ? { tools: true } : {}),
          ...(caps.includes('thinking') ? { reasoning: true } : {}),
        };
      }
      return info;
    });
    if (this.kind === 'llamacpp') {
      // /props で n_ctx と modalities、chat_template(思考対応の検出)が取れる(単一モデル運用が前提)
      try {
        const props = await requestJson<{
          default_generation_settings?: { n_ctx?: number };
          modalities?: { vision?: boolean; audio?: boolean };
          chat_template?: string;
          chat_template_caps?: { supports_reasoning_effort?: boolean };
        }>(profile, '/props', { signal, timeoutMs: 5_000 });
        const reasoning = props.chat_template
          ? detectReasoningFromTemplate(props.chat_template)
          : null;
        for (const m of models) {
          if (props.default_generation_settings?.n_ctx)
            m.contextLength = props.default_generation_settings.n_ctx;
          if (props.modalities) {
            m.capabilities = {
              ...m.capabilities,
              ...(props.modalities.vision !== undefined ? { image: props.modalities.vision } : {}),
              ...(props.modalities.audio !== undefined ? { audio: props.modalities.audio } : {}),
            };
          }
          if (reasoning) {
            m.capabilities = {
              ...m.capabilities,
              reasoning: reasoning.reasoning,
              reasoningLevels: reasoning.levels,
            };
          }
        }
      } catch {
        /* 古い llama.cpp や別実装では /props が無い */
      }
    }
    if (this.kind === 'lmstudio') await mergeLmStudioCapabilities(profile, models, signal);
    if (this.kind === 'unsloth')
      return expandUnslothVariants(profile, res.data ?? [], models, signal);
    return models;
  }

  /**
   * Unsloth だけモデル単位の情報が取れる: 常駐中なら /v1/status(supports_reasoning、reasoning_effort_levels、
   * is_vision 等)、未ロードなら /v1/validate で chat_template を読んで思考対応を検出する。
   */
  async describeModel(
    profile: ServerProfile,
    model: string,
    signal?: AbortSignal,
  ): Promise<ModelInfo | null> {
    if (this.kind !== 'unsloth') {
      // llama.cpp / LM Studio は一覧取得時にサーバー申告(/props、/api/v1/models)を付けているので、そこから引く
      try {
        const list = await this.listModels(profile, signal);
        return list.find((m) => m.id === model) ?? null;
      } catch {
        return null;
      }
    }
    const { id, quant } = splitUnslothModel([], model);
    const name = id.split('/').pop() ?? id;
    try {
      const st = await requestJson<{
        active_model?: string | null;
        model_identifier?: string | null;
        loaded?: string[];
        supports_reasoning?: boolean;
        reasoning_style?: string;
        reasoning_effort_levels?: string[];
        supports_tools?: boolean;
        is_vision?: boolean;
        has_audio_input?: boolean;
        has_video_input?: boolean;
      }>(profile, '/v1/status', { signal, timeoutMs: 8_000 });
      const resident = [st.active_model, st.model_identifier, ...(st.loaded ?? [])].filter(
        (x): x is string => typeof x === 'string',
      );
      if (resident.some((r) => r === id || r === model || r.endsWith(`/${name}`))) {
        let levels = st.reasoning_effort_levels ?? [];
        // 純粋な reasoning_effort 型(gpt-oss 等)は候補が返らないので一般的な 3 段を出す
        if (levels.length === 0 && st.reasoning_style === 'reasoning_effort')
          levels = ['low', 'medium', 'high'];
        // 常駐中のモデルのコンテキスト長は /api/inference/monitor の context_length にある(M14)
        let contextLength: number | undefined;
        try {
          const mon = await requestJson<{ context_length?: number | null }>(
            profile,
            '/api/inference/monitor',
            { signal, timeoutMs: 8_000 },
          );
          if (typeof mon.context_length === 'number' && mon.context_length > 0)
            contextLength = mon.context_length;
        } catch {
          /* 取れなくても他の情報は返す */
        }
        return {
          id: model,
          ...(contextLength ? { contextLength } : {}),
          name,
          loaded: true,
          capabilities: {
            ...(st.supports_reasoning !== undefined ? { reasoning: st.supports_reasoning } : {}),
            reasoningLevels: st.supports_reasoning ? levels : [],
            ...(st.supports_tools !== undefined ? { tools: st.supports_tools } : {}),
            ...(st.is_vision !== undefined ? { image: st.is_vision } : {}),
            ...(st.has_audio_input !== undefined ? { audio: st.has_audio_input } : {}),
          },
        };
      }
    } catch {
      /* status が取れなくても validate で続ける */
    }
    try {
      const v = await requestJson<{
        valid?: boolean;
        is_vision?: boolean;
        chat_template?: string | null;
        context_length?: number | null;
      }>(profile, '/v1/validate', {
        method: 'POST',
        body: {
          model_path: id,
          ...(quant ? { gguf_variant: quant } : {}),
          include_chat_template: true,
        },
        signal,
        timeoutMs: 30_000,
      });
      if (!v.valid) return null;
      const r = detectReasoningFromTemplate(v.chat_template);
      const info: ModelInfo = {
        id: model,
        name,
        capabilities: {
          ...(v.is_vision !== undefined ? { image: v.is_vision } : {}),
          ...(v.chat_template ? { reasoning: r.reasoning, reasoningLevels: r.levels } : {}),
        },
      };
      if (v.context_length) info.contextLength = v.context_length;
      return info;
    } catch {
      return null;
    }
  }

  async *chat(
    profile: ServerProfile,
    req: ChatRequest,
    signal: AbortSignal,
  ): AsyncIterable<ChatEvent> {
    const res = await request(profile, '/v1/chat/completions', {
      method: 'POST',
      body: buildBody(this.kind, req),
      signal,
      timeoutMs: 60_000,
    });
    if (!res.body) throw new Error('empty response body');

    const pending = new Map<number, { id: string; name: string; args: string }>();
    let finish: ChatEvent | null = null;
    let sawToolCalls = false;
    const startedAt = Date.now();
    let usageSent = false;

    for await (const ev of parseSse(res.body)) {
      if (ev.data === '[DONE]') break;
      let chunk: Chunk;
      try {
        chunk = JSON.parse(ev.data) as Chunk;
      } catch {
        continue;
      }
      if (chunk.error) {
        const msg =
          typeof chunk.error === 'string' ? chunk.error : (chunk.error.message ?? 'unknown error');
        yield { type: 'error', message: msg };
        return;
      }
      const choice = chunk.choices?.[0];
      const delta = choice?.delta;
      if (delta) {
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (reasoning) yield { type: 'reasoning-delta', text: reasoning };
        if (delta.content) yield { type: 'text-delta', text: delta.content };
        for (const tc of delta.tool_calls ?? []) {
          sawToolCalls = true;
          const idx = tc.index ?? 0;
          const cur = pending.get(idx) ?? { id: '', name: '', args: '' };
          if (tc.id) cur.id = tc.id;
          if (tc.function?.name) cur.name += tc.function.name;
          if (tc.function?.arguments) cur.args += tc.function.arguments;
          pending.set(idx, cur);
        }
      }
      if (choice?.finish_reason) {
        finish = { type: 'done', finishReason: mapFinish(choice.finish_reason, sawToolCalls) };
      }
      if (chunk.usage) {
        usageSent = true;
        yield {
          type: 'usage',
          usage: {
            ...(chunk.usage.prompt_tokens !== undefined
              ? { promptTokens: chunk.usage.prompt_tokens }
              : {}),
            ...(chunk.usage.completion_tokens !== undefined
              ? { completionTokens: chunk.usage.completion_tokens }
              : {}),
            durationMs: chunk.timings?.predicted_ms ?? Date.now() - startedAt,
          },
        };
      }
    }

    for (const [, c] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
      const call: ToolCall = {
        id: c.id || `call_${Math.random().toString(36).slice(2, 10)}`,
        name: c.name,
        args: c.args || '{}',
      };
      yield { type: 'tool-call', call };
    }
    if (!usageSent) yield { type: 'usage', usage: { durationMs: Date.now() - startedAt } };
    yield finish ?? { type: 'done', finishReason: sawToolCalls ? 'tool_calls' : 'stop' };
  }
}

function mapFinish(reason: string, sawToolCalls: boolean): 'stop' | 'length' | 'tool_calls' {
  if (reason === 'length') return 'length';
  if (reason === 'tool_calls' || reason === 'function_call' || sawToolCalls) return 'tool_calls';
  return 'stop';
}

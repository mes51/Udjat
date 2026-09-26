import type { ChatEvent, ModelInfo, ServerKind, ServerProfile, ToolCall } from '@shared/schemas';
import { request, requestJson } from './http';
import { parseSse } from './stream-parsers';
import type { CanonicalMessage, ChatRequest, ProviderAdapter } from './types';

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

function buildBody(kind: ServerKind, req: ChatRequest): Record<string, unknown> {
  const p = req.params;
  const body: Record<string, unknown> = {
    model: req.model,
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
  if (p.think !== undefined) {
    // llama.cpp: reasoning_budget=0 で思考を無効化。vLLM / LM Studio: chat_template_kwargs.enable_thinking
    if (kind === 'llamacpp') body['reasoning_budget'] = p.think ? -1 : 0;
    else body['chat_template_kwargs'] = { enable_thinking: p.think };
  }
  if (req.tools && req.tools.length > 0 && req.capabilities.tools) {
    body['tools'] = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  return body;
}

export class OpenAICompatibleAdapter implements ProviderAdapter {
  constructor(readonly kind: ServerKind) {}

  async listModels(profile: ServerProfile, signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await requestJson<{
      data?: { id: string; meta?: { n_ctx_train?: number; n_params?: number } }[];
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
      // /props で n_ctx と modalities が取れる(単一モデル運用が前提)
      try {
        const props = await requestJson<{
          default_generation_settings?: { n_ctx?: number };
          modalities?: { vision?: boolean; audio?: boolean };
        }>(profile, '/props', { signal, timeoutMs: 5_000 });
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
        }
      } catch {
        /* 古い llama.cpp や別実装では /props が無い */
      }
    }
    return models;
  }

  async describeModel(): Promise<ModelInfo | null> {
    return null;
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

import type { ChatEvent, ModelInfo, ServerProfile, ToolCall } from '@shared/schemas';
import { request, requestJson } from './http';
import { parseNdjson } from './stream-parsers';
import type { CanonicalMessage, ChatRequest, ProviderAdapter } from './types';

/**
 * Ollama ネイティブ API(/api/chat)アダプタ。
 * OpenAI 互換層より情報が多く、num_ctx / think / images を確実に渡せる。
 */

interface OllamaMessage {
  role: string;
  content: string;
  thinking?: string;
  images?: string[];
  tool_calls?: { function: { name: string; arguments: Record<string, unknown> } }[];
  tool_name?: string;
}

interface OllamaChunk {
  message?: {
    role?: string;
    content?: string;
    thinking?: string;
    tool_calls?: { function?: { name?: string; arguments?: unknown } }[];
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  eval_duration?: number; // ナノ秒
  error?: string;
}

function toOllamaMessages(messages: CanonicalMessage[]): OllamaMessage[] {
  return messages.map((m) => {
    const out: OllamaMessage = { role: m.role, content: m.text };
    if (m.images && m.images.length > 0) out.images = m.images.map((i) => i.base64);
    if (m.reasoning) out.thinking = m.reasoning;
    if (m.toolCalls && m.toolCalls.length > 0) {
      out.tool_calls = m.toolCalls.map((c) => ({
        function: { name: c.name, arguments: safeParseArgs(c.args) },
      }));
    }
    if (m.role === 'tool' && m.name) out.tool_name = m.name;
    return out;
  });
}

function safeParseArgs(args: string): Record<string, unknown> {
  try {
    const v = JSON.parse(args) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function buildBody(req: ChatRequest): Record<string, unknown> {
  const p = req.params;
  const options: Record<string, unknown> = {};
  if (p.temperature !== undefined) options['temperature'] = p.temperature;
  if (p.topP !== undefined) options['top_p'] = p.topP;
  if (p.topK !== undefined) options['top_k'] = p.topK;
  if (p.minP !== undefined) options['min_p'] = p.minP;
  if (p.maxTokens !== undefined) options['num_predict'] = p.maxTokens;
  if (p.contextLength !== undefined) options['num_ctx'] = p.contextLength;
  if (p.seed !== undefined) options['seed'] = p.seed;
  if (p.stop && p.stop.length > 0) options['stop'] = p.stop;
  if (p.repeatPenalty !== undefined) options['repeat_penalty'] = p.repeatPenalty;

  const body: Record<string, unknown> = {
    model: req.model,
    messages: toOllamaMessages(req.messages),
    stream: true,
    options,
  };
  // think は対応モデル以外に送るとエラーになるため、明示指定かつ reasoning 対応の時だけ付ける
  if (p.think !== undefined && req.capabilities.reasoning) body['think'] = p.think;
  if (req.tools && req.tools.length > 0 && req.capabilities.tools) {
    body['tools'] = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  return body;
}

export class OllamaAdapter implements ProviderAdapter {
  readonly kind = 'ollama' as const;

  async listModels(profile: ServerProfile, signal?: AbortSignal): Promise<ModelInfo[]> {
    const res = await requestJson<{
      models?: { name: string; model?: string; size?: number; details?: Record<string, unknown> }[];
    }>(profile, '/api/tags', { signal, timeoutMs: 5_000 });
    return (res.models ?? []).map((m) => {
      const info: ModelInfo = { id: m.model ?? m.name, name: m.name };
      if (m.details)
        info.details = { ...m.details, ...(m.size !== undefined ? { size: m.size } : {}) };
      return info;
    });
  }

  async describeModel(
    profile: ServerProfile,
    model: string,
    signal?: AbortSignal,
  ): Promise<ModelInfo | null> {
    const res = await requestJson<{
      capabilities?: string[];
      model_info?: Record<string, unknown>;
      details?: Record<string, unknown>;
    }>(profile, '/api/show', { method: 'POST', body: { model }, signal });
    const caps = new Set(res.capabilities ?? []);
    const info: ModelInfo = {
      id: model,
      name: model,
      capabilities: {
        image: caps.has('vision'),
        tools: caps.has('tools'),
        reasoning: caps.has('thinking'),
      },
    };
    const ctxKey = Object.keys(res.model_info ?? {}).find((k) => k.endsWith('.context_length'));
    const ctx = ctxKey ? res.model_info?.[ctxKey] : undefined;
    if (typeof ctx === 'number') info.contextLength = ctx;
    if (res.details) info.details = res.details;
    return info;
  }

  async *chat(
    profile: ServerProfile,
    req: ChatRequest,
    signal: AbortSignal,
  ): AsyncIterable<ChatEvent> {
    const res = await request(profile, '/api/chat', {
      method: 'POST',
      body: buildBody(req),
      signal,
      timeoutMs: 60_000,
    });
    if (!res.body) throw new Error('empty response body');

    const startedAt = Date.now();
    let sawToolCalls = false;
    let n = 0;
    for await (const chunk of parseNdjson<OllamaChunk>(res.body)) {
      if (chunk.error) {
        yield { type: 'error', message: chunk.error };
        return;
      }
      const m = chunk.message;
      if (m?.thinking) yield { type: 'reasoning-delta', text: m.thinking };
      if (m?.content) yield { type: 'text-delta', text: m.content };
      for (const tc of m?.tool_calls ?? []) {
        sawToolCalls = true;
        const call: ToolCall = {
          id: `call_${startedAt.toString(36)}_${n++}`,
          name: tc.function?.name ?? '',
          args: JSON.stringify(tc.function?.arguments ?? {}),
        };
        yield { type: 'tool-call', call };
      }
      if (chunk.done) {
        yield {
          type: 'usage',
          usage: {
            ...(chunk.prompt_eval_count !== undefined
              ? { promptTokens: chunk.prompt_eval_count }
              : {}),
            ...(chunk.eval_count !== undefined ? { completionTokens: chunk.eval_count } : {}),
            durationMs:
              chunk.eval_duration !== undefined
                ? chunk.eval_duration / 1e6
                : Date.now() - startedAt,
          },
        };
        const reason = chunk.done_reason;
        yield {
          type: 'done',
          finishReason: sawToolCalls ? 'tool_calls' : reason === 'length' ? 'length' : 'stop',
        };
        return;
      }
    }
    yield { type: 'done', finishReason: sawToolCalls ? 'tool_calls' : 'stop' };
  }
}

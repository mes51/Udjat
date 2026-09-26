import type { Capabilities, CapabilityOverrides, ModelInfo, ServerKind } from '@shared/schemas';

/**
 * capability の推定。優先順位:
 *   1. ユーザーの上書き(profile.capabilityOverrides)
 *   2. サーバー自己申告(ModelInfo.capabilities: Ollama /api/show, llama.cpp /props)
 *   3. サーバー種別 + モデル名のヒューリスティクス
 */

const VISION_PATTERNS = [
  /vl\b/, // qwen3-vl, qwen2.5vl:7b, qwen2.5-vl-7b
  /vl-/,
  /vision/,
  /llava/,
  /gemma-?3(?!n)/, // gemma3 は 4b 以上が vision。1b を除外するのは難しいので許容
  /gemma-?4/,
  /minicpm-?v/,
  /moondream/,
  /pixtral/,
  /llama-?4/,
  /llama3\.2-vision/,
  /mistral-?small-?3/,
  /omni/,
  /smolvlm/,
  /internvl/,
  /phi-?4-?multimodal/,
  /granite.*vision/,
  /molmo/,
  /idefics/,
  /paligemma/,
];

const AUDIO_PATTERNS = [/omni/, /ultravox/, /audio/, /voxtral/, /gemma-?3n/];

const REASONING_PATTERNS = [
  /qwen-?3/,
  /deepseek-?r1/,
  /gpt-?oss/,
  /magistral/,
  /phi-?4-?reasoning/,
  /qwq/,
  /glm-?4\.[5-9]/,
  /exaone-?deep/,
  /-thinking/,
  /nemotron/,
];

function matchAny(name: string, patterns: RegExp[]): boolean {
  const n = name.toLowerCase();
  return patterns.some((p) => p.test(n));
}

export function guessFromModelName(kind: ServerKind, model: string): Capabilities {
  const image = matchAny(model, VISION_PATTERNS);
  const nativeMedia = kind === 'llamacpp' || kind === 'vllm';
  return {
    image,
    audio: nativeMedia && matchAny(model, AUDIO_PATTERNS),
    video: nativeMedia && image ? 'native' : 'none',
    tools: true,
    streamingToolCalls: true,
    toolResultMedia: 'follow-up-user-message',
    reasoning: matchAny(model, REASONING_PATTERNS),
  };
}

/**
 * 優先順位: ヒューリスティクス < サーバー自己申告 < プロファイル全体の上書き < モデル単位の上書き
 */
export function resolveCapabilities(
  kind: ServerKind,
  model: string,
  reported: ModelInfo['capabilities'] | undefined,
  overrides: CapabilityOverrides,
  modelOverrides: CapabilityOverrides = {},
): Capabilities {
  const merged: Capabilities = { ...guessFromModelName(kind, model) };
  for (const src of [reported ?? {}, overrides, modelOverrides]) {
    for (const [k, v] of Object.entries(src)) {
      if (v !== undefined) (merged as unknown as Record<string, unknown>)[k] = v;
    }
  }
  // 画像非対応なら動画のネイティブ入力もあり得ない(明示的に video を上書きした場合を除く)
  const videoForced = modelOverrides.video !== undefined || overrides.video !== undefined;
  if (!merged.image && merged.video === 'native' && !videoForced) merged.video = 'none';
  return merged;
}

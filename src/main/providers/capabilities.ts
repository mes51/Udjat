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
    reasoningLevels: [],
  };
}

/** 思考レベルの正規の並び(テンプレートから拾った語をこの順に揃える) */
export const REASONING_LEVEL_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

export interface TemplateReasoning {
  /** 思考の ON/OFF をテンプレートが受け付けるか(enable_thinking 等) */
  reasoning: boolean;
  /** reasoning_effort をテンプレートが読む時、その候補 */
  levels: string[];
}

/**
 * chat template(Jinja)から思考対応とレベルを検出する。モデル名のヒューリスティクスより確実で、
 * llama.cpp(/props の chat_template)と Unsloth(/v1/validate の chat_template)で使う。
 *
 * - enable_thinking / thinking 変数、<|think|>、<think> があれば思考対応
 * - reasoning_effort を読むテンプレートは、比較や変数名に現れるレベル語を候補にする
 *   (Qwen3.8: 'xhigh' | 'medium' | 'low'、DeepSeek V4: reasoning_effort_high / _max、gpt-oss: Reasoning: low|medium|high)
 */
export function detectReasoningFromTemplate(
  template: string | null | undefined,
): TemplateReasoning {
  const t = template ?? '';
  if (!t) return { reasoning: false, levels: [] };
  const usesEffort = /reasoning_effort/.test(t);
  const reasoning =
    usesEffort ||
    /enable_thinking/.test(t) ||
    /\bthinking\s+is\s+(?:defined|true|false)/.test(t) ||
    /<\|think\|>/.test(t) ||
    /<think>/.test(t);
  if (!usesEffort) return { reasoning, levels: [] };
  const found = new Set<string>();
  // 'high' のような引用付きの語、reasoning_effort_high のような変数名の両方を拾う
  for (const m of t.matchAll(/['"](minimal|low|medium|high|xhigh|max)['"]/g)) found.add(m[1]!);
  for (const m of t.matchAll(/reasoning_effort_(minimal|low|medium|high|xhigh|max)\b/g))
    found.add(m[1]!);
  // gpt-oss(Harmony): "Reasoning: low" のような文字列
  for (const m of t.matchAll(/Reasoning:\s*(minimal|low|medium|high|xhigh|max)\b/g))
    found.add(m[1]!);
  const levels = REASONING_LEVEL_ORDER.filter((l) => found.has(l));
  return { reasoning, levels: [...levels] };
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
  // 思考非対応ならレベルも無い
  if (!merged.reasoning) merged.reasoningLevels = [];
  merged.reasoningLevels = [
    ...new Set(merged.reasoningLevels.map((l) => l.trim().toLowerCase())),
  ].filter(Boolean);
  return merged;
}

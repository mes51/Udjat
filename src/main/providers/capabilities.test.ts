import { describe, expect, it } from 'vitest';
import {
  detectReasoningFromTemplate,
  guessFromModelName,
  resolveCapabilities,
} from './capabilities';

describe('guessFromModelName', () => {
  it('detects vision models and native video only on llama.cpp / vLLM', () => {
    expect(guessFromModelName('llamacpp', 'Qwen3-VL-8B-Instruct-Q4_K_M.gguf')).toMatchObject({
      image: true,
      video: 'native',
      reasoning: true,
    });
    expect(guessFromModelName('ollama', 'qwen2.5vl:7b')).toMatchObject({
      image: true,
      video: 'none',
    });
    expect(guessFromModelName('lmstudio', 'gemma-3-12b-it')).toMatchObject({
      image: true,
      video: 'none',
    });
  });

  it('treats plain text models as text-only', () => {
    expect(guessFromModelName('ollama', 'llama3.1:8b')).toMatchObject({
      image: false,
      audio: false,
      video: 'none',
      reasoning: false,
    });
  });

  it('detects reasoning and audio models', () => {
    expect(guessFromModelName('ollama', 'deepseek-r1:14b').reasoning).toBe(true);
    expect(guessFromModelName('ollama', 'gpt-oss:20b').reasoning).toBe(true);
    expect(guessFromModelName('llamacpp', 'Qwen2.5-Omni-7B').audio).toBe(true);
    expect(guessFromModelName('ollama', 'Qwen2.5-Omni-7B').audio).toBe(false);
  });
});

describe('resolveCapabilities', () => {
  it('lets server-reported values override the guess and user overrides win over both', () => {
    const caps = resolveCapabilities(
      'ollama',
      'mystery-model',
      { image: true, tools: false },
      { tools: true },
    );
    expect(caps).toMatchObject({ image: true, tools: true });
  });

  it('applies per-model overrides on top of profile overrides', () => {
    const caps = resolveCapabilities(
      'openai-compatible',
      'mystery',
      undefined,
      { image: false },
      { image: true, video: 'native' },
    );
    expect(caps.image).toBe(true);
    expect(caps.video).toBe('native');
    // モデル上書きなしならプロファイル上書きが効く
    expect(
      resolveCapabilities('openai-compatible', 'mystery', undefined, { image: false }).image,
    ).toBe(false);
  });

  it('drops native video when image is disabled unless the user forced it', () => {
    expect(resolveCapabilities('llamacpp', 'qwen3-vl', undefined, { image: false }).video).toBe(
      'none',
    );
    expect(
      resolveCapabilities('llamacpp', 'qwen3-vl', undefined, { image: false, video: 'native' })
        .video,
    ).toBe('native');
  });
});

describe('detectReasoningFromTemplate', () => {
  it('detects enable_thinking templates (Gemma 4, Qwen3.5) without levels', () => {
    const gemma4 = `{%- set enable_thinking = enable_thinking | default(false) -%}
{%- if enable_thinking -%}{{- '<|think|>\n' -}}{%- endif -%}`;
    expect(detectReasoningFromTemplate(gemma4)).toEqual({ reasoning: true, levels: [] });
    const qwen35 = `{%- if enable_thinking is defined and enable_thinking is false %}{{- '<think>\n\n</think>\n\n' }}{%- else %}{{- '<think>\n' }}{%- endif %}`;
    expect(detectReasoningFromTemplate(qwen35)).toEqual({ reasoning: true, levels: [] });
  });

  it('extracts reasoning_effort levels (Qwen3.8, DeepSeek V4, gpt-oss)', () => {
    const qwen38 = `{%- if enable_thinking is undefined or enable_thinking is true %}
{%- set resolved_reasoning_effort = reasoning_effort|default('xhigh') %}
{%- if resolved_reasoning_effort == 'high' %}{%- set resolved_reasoning_effort = 'xhigh' %}{%- endif %}
{%- if resolved_reasoning_effort not in ('xhigh', 'medium', 'low') %}{{- raise_exception('Unexpected') }}{%- endif %}`;
    expect(detectReasoningFromTemplate(qwen38)).toEqual({
      reasoning: true,
      levels: ['low', 'medium', 'high', 'xhigh'],
    });
    const deepseekV4 = `{%- if not thinking is defined -%}{%- if enable_thinking is defined -%}{%- set thinking = enable_thinking -%}{%- endif -%}{%- endif -%}
{%- if not reasoning_effort is defined -%}{%- set reasoning_effort = none -%}{%- endif -%}
{%- set reasoning_effort_high = 'Reasoning Effort: Absolute maximum' -%}
{%- set reasoning_effort_max = 'Reasoning Effort: Beyond maximum' -%}
{%- if thinking -%}{%- if reasoning_effort == 'high' -%}{{ reasoning_effort_high }}{%- elif reasoning_effort == 'max' -%}{{ reasoning_effort_max }}{%- endif -%}{%- endif -%}`;
    expect(detectReasoningFromTemplate(deepseekV4)).toEqual({
      reasoning: true,
      levels: ['high', 'max'],
    });
    const gptOss = `{%- if reasoning_effort is not defined %}{%- set reasoning_effort = "medium" %}{%- endif %}
{{- "Reasoning: " + reasoning_effort + "\n\n" }}`;
    expect(detectReasoningFromTemplate(gptOss)).toEqual({ reasoning: true, levels: ['medium'] });
  });

  it('reports no reasoning for plain templates', () => {
    const llama3 = `{{- bos_token }}{%- for message in messages %}<|start_header_id|>{{ message['role'] }}<|end_header_id|>{{ message['content'] }}<|eot_id|>{%- endfor %}`;
    expect(detectReasoningFromTemplate(llama3)).toEqual({ reasoning: false, levels: [] });
    expect(detectReasoningFromTemplate('')).toEqual({ reasoning: false, levels: [] });
  });

  it('clears levels when reasoning is off after resolution', () => {
    const caps = resolveCapabilities(
      'llamacpp',
      'm',
      { reasoning: true, reasoningLevels: ['Low', 'high'] },
      {},
      {},
    );
    expect(caps.reasoningLevels).toEqual(['low', 'high']);
    expect(
      resolveCapabilities(
        'llamacpp',
        'm',
        { reasoning: true, reasoningLevels: ['low'] },
        { reasoning: false },
        {},
      ).reasoningLevels,
    ).toEqual([]);
  });
});

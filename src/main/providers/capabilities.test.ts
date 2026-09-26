import { describe, expect, it } from 'vitest';
import { guessFromModelName, resolveCapabilities } from './capabilities';

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

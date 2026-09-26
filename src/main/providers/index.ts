import type { ServerKind } from '@shared/schemas';
import { OllamaAdapter } from './ollama';
import { OpenAICompatibleAdapter } from './openai-compatible';
import type { ProviderAdapter } from './types';

const cache = new Map<ServerKind, ProviderAdapter>();

export function getAdapter(kind: ServerKind): ProviderAdapter {
  let a = cache.get(kind);
  if (!a) {
    a = kind === 'ollama' ? new OllamaAdapter() : new OpenAICompatibleAdapter(kind);
    cache.set(kind, a);
  }
  return a;
}

export type {
  ProviderAdapter,
  ChatRequest,
  CanonicalMessage,
  CanonicalMedia,
  ToolDefinition,
} from './types';
export { ProviderError } from './types';
export { resolveCapabilities, guessFromModelName } from './capabilities';

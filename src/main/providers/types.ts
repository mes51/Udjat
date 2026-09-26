import type {
  Capabilities,
  ChatEvent,
  ChatParams,
  ModelInfo,
  ServerKind,
  ServerProfile,
  ToolCall,
} from '@shared/schemas';

/** 添付をデコード済みの形で持つ、プロバイダ非依存のメッセージ */
export interface CanonicalMedia {
  mime: string;
  /** base64(data: プレフィックスなし) */
  base64: string;
  name?: string;
}

export interface CanonicalMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  text: string;
  reasoning?: string;
  images?: CanonicalMedia[];
  audio?: CanonicalMedia[];
  video?: CanonicalMedia[];
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ChatRequest {
  model: string;
  messages: CanonicalMessage[];
  params: ChatParams;
  tools?: ToolDefinition[];
  capabilities: Capabilities;
}

export interface ServerProbe {
  ok: boolean;
  /** サーバーが返した識別情報(バージョン等) */
  info: Record<string, unknown>;
  models: ModelInfo[];
}

export interface ProviderAdapter {
  readonly kind: ServerKind;
  listModels(profile: ServerProfile, signal?: AbortSignal): Promise<ModelInfo[]>;
  /** モデル単位の追加情報(Ollama /api/show 等)。無ければ null */
  describeModel(
    profile: ServerProfile,
    model: string,
    signal?: AbortSignal,
  ): Promise<ModelInfo | null>;
  chat(profile: ServerProfile, req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

import type {
  Capabilities,
  ChatEvent,
  ChatParams,
  ModelInfo,
  ModelStatus,
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
  /** role: tool の時の関数名(Ollama は id ではなく名前で対応付ける) */
  name?: string;
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

/** サーバー側のモデル常駐を操作する(対応サーバーのみ)。設計は docs/plan/07 の M10 */
export interface ModelManager {
  status(profile: ServerProfile, signal?: AbortSignal): Promise<ModelStatus>;
  /** ロード完了まで待つ(大きいモデルは分単位)。失敗は ProviderError */
  load(profile: ServerProfile, model: string, signal?: AbortSignal): Promise<void>;
  unload(profile: ServerProfile, model: string, signal?: AbortSignal): Promise<void>;
}

export interface ProviderAdapter {
  readonly kind: ServerKind;
  /** モデル常駐の操作。無ければこのサーバー種別では扱えない */
  readonly models?: ModelManager | undefined;
  listModels(profile: ServerProfile, signal?: AbortSignal): Promise<ModelInfo[]>;
  /** モデル単位の追加情報(Ollama /api/show 等)。無ければ null */
  describeModel(
    profile: ServerProfile,
    model: string,
    signal?: AbortSignal,
  ): Promise<ModelInfo | null>;
  chat(profile: ServerProfile, req: ChatRequest, signal: AbortSignal): AsyncIterable<ChatEvent>;
}

export type ProviderErrorCode =
  | 'refused'
  | 'dns'
  | 'timeout'
  | 'tls'
  | 'network'
  | 'unauthorized'
  | 'not-found'
  | 'server'
  | 'http'
  | 'not-json';

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
    readonly code: ProviderErrorCode = 'http',
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

import { z } from 'zod';

/**
 * main / renderer 共通のドメイン型。zod スキーマから型を導出する。
 * 設計: docs/plan/02-architecture.md, 05-data-model.md
 */

export const ServerKindSchema = z.enum([
  'ollama',
  'llamacpp',
  'vllm',
  'lmstudio',
  'openai-compatible',
]);
export type ServerKind = z.infer<typeof ServerKindSchema>;

export const SERVER_KIND_LABELS: Record<ServerKind, string> = {
  ollama: 'Ollama',
  llamacpp: 'llama.cpp (llama-server)',
  vllm: 'vLLM',
  lmstudio: 'LM Studio',
  'openai-compatible': 'OpenAI 互換 (汎用)',
};

/** 生成パラメータ。未指定(undefined)はサーバー既定に従う。 */
export const ChatParamsSchema = z.object({
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  topK: z.number().int().min(0).optional(),
  minP: z.number().min(0).max(1).optional(),
  maxTokens: z.number().int().min(1).optional(),
  /** Ollama の num_ctx。他サーバーは起動時固定なので無視される */
  contextLength: z.number().int().min(1).optional(),
  seed: z.number().int().optional(),
  stop: z.array(z.string()).optional(),
  repeatPenalty: z.number().min(0).optional(),
  /** thinking 系モデルの思考を有効化するか(未指定ならサーバー既定) */
  think: z.boolean().optional(),
});
export type ChatParams = z.infer<typeof ChatParamsSchema>;

export const CapabilitiesSchema = z.object({
  image: z.boolean(),
  audio: z.boolean(),
  video: z.enum(['native', 'none']),
  tools: z.boolean(),
  streamingToolCalls: z.boolean(),
  toolResultMedia: z.enum(['inline', 'follow-up-user-message']),
  reasoning: z.boolean(),
});
export type Capabilities = z.infer<typeof CapabilitiesSchema>;
export const CapabilityOverridesSchema = CapabilitiesSchema.partial();
export type CapabilityOverrides = z.infer<typeof CapabilityOverridesSchema>;

export const ServerProfileSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  kind: ServerKindSchema,
  baseUrl: z.string().url(),
  apiKey: z.string().nullable(),
  defaultModel: z.string().nullable(),
  defaultParams: ChatParamsSchema,
  /** プロファイル全体(全モデル)への上書き */
  capabilityOverrides: CapabilityOverridesSchema,
  /** モデル id ごとの上書き(プロファイル全体の上書きより優先) */
  modelCapabilityOverrides: z.record(z.string(), CapabilityOverridesSchema),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ServerProfile = z.infer<typeof ServerProfileSchema>;

export const ServerProfileInputSchema = ServerProfileSchema.pick({
  name: true,
  kind: true,
  baseUrl: true,
  apiKey: true,
  defaultModel: true,
  defaultParams: true,
  capabilityOverrides: true,
}).extend({
  modelCapabilityOverrides: z.record(z.string(), CapabilityOverridesSchema).default({}),
});
/** 入力側の型(modelCapabilityOverrides は省略可) */
export type ServerProfileInput = z.input<typeof ServerProfileInputSchema>;

export const ModelInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  contextLength: z.number().optional(),
  /** サーバーが自己申告した capability(Ollama /api/show 等) */
  capabilities: CapabilityOverridesSchema.optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

export const AttachmentMetaSchema = z.object({
  kind: z.enum(['image', 'video', 'audio', 'file']),
  width: z.number().optional(),
  height: z.number().optional(),
  durationMs: z.number().optional(),
  fps: z.number().optional(),
  hasAudio: z.boolean().optional(),
  codec: z.string().optional(),
  probeError: z.string().optional(),
  /** 派生物(フレーム・コンタクトシート等)の元になった添付 id */
  derivedFrom: z.string().optional(),
  /** 派生物の説明(例: frame@12.5s, contact-sheet 0-95s) */
  derivedLabel: z.string().optional(),
  /** 派生フレームの時刻(ミリ秒) */
  timestampMs: z.number().optional(),
});
export type AttachmentMeta = z.infer<typeof AttachmentMetaSchema>;

export const AttachmentSchema = z.object({
  id: z.string(),
  sha256: z.string(),
  mime: z.string(),
  ext: z.string(),
  originalName: z.string(),
  size: z.number(),
  meta: AttachmentMetaSchema,
  refCount: z.number(),
  createdAt: z.number(),
});
export type Attachment = z.infer<typeof AttachmentSchema>;

/** 送信時の添付指定 */
export const AttachmentRefSchema = z.object({
  id: z.string(),
  /** 動画の送り方。tools = ツールで参照(既定)、native = 動画をそのまま送る */
  sendMode: z.enum(['tools', 'native']).optional(),
});
export type AttachmentRef = z.infer<typeof AttachmentRefSchema>;

export const RoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export type Role = z.infer<typeof RoleSchema>;

export const PartSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('reasoning'), text: z.string() }),
  z.object({ type: z.literal('image'), attachmentId: z.string(), name: z.string().optional() }),
  z.object({ type: z.literal('audio'), attachmentId: z.string(), name: z.string().optional() }),
  z.object({
    type: z.literal('video'),
    attachmentId: z.string(),
    name: z.string().optional(),
    sendMode: z.enum(['tools', 'native']).optional(),
  }),
  z.object({ type: z.literal('file'), attachmentId: z.string(), name: z.string().optional() }),
]);
export type Part = z.infer<typeof PartSchema>;

export const ToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** JSON 文字列。パースは実行側で行う */
  args: z.string(),
});
export type ToolCall = z.infer<typeof ToolCallSchema>;

export const ToolPolicySchema = z.enum(['auto', 'ask', 'deny']);
export type ToolPolicy = z.infer<typeof ToolPolicySchema>;

export const ToolInfoSchema = z.object({
  name: z.string(),
  description: z.string(),
  source: z.enum(['builtin', 'mcp']),
  policy: ToolPolicySchema,
});
export type ToolInfo = z.infer<typeof ToolInfoSchema>;

/** tool メッセージの tool_meta に入れる実行記録 */
export const ToolMetaSchema = z.object({
  name: z.string(),
  args: z.string(),
  durationMs: z.number(),
  isError: z.boolean(),
  approval: z.enum(['auto', 'approved', 'approved-conversation', 'denied']),
});
export type ToolMeta = z.infer<typeof ToolMetaSchema>;

export const ToolApprovalDecisionSchema = z.enum(['allow', 'allow-conversation', 'deny']);
export type ToolApprovalDecision = z.infer<typeof ToolApprovalDecisionSchema>;

export const UsageSchema = z.object({
  promptTokens: z.number().optional(),
  completionTokens: z.number().optional(),
  /** 生成部分の所要時間(ミリ秒) */
  durationMs: z.number().optional(),
});
export type Usage = z.infer<typeof UsageSchema>;

export const FinishReasonSchema = z.enum(['stop', 'length', 'tool_calls', 'aborted', 'error']);
export type FinishReason = z.infer<typeof FinishReasonSchema>;

export const MessageKindSchema = z.enum(['normal', 'tool-media', 'note']);
export type MessageKind = z.infer<typeof MessageKindSchema>;

export const MessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  parentId: z.string().nullable(),
  role: RoleSchema,
  kind: MessageKindSchema,
  parts: z.array(PartSchema),
  toolCalls: z.array(ToolCallSchema).nullable(),
  toolCallId: z.string().nullable(),
  toolMeta: z.unknown().nullable(),
  model: z.string().nullable(),
  usage: UsageSchema.nullable(),
  finishReason: FinishReasonSchema.nullable(),
  /** エラー終了時の説明 */
  error: z.string().nullable(),
  createdAt: z.number(),
});
export type Message = z.infer<typeof MessageSchema>;

export const ConversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  pinned: z.boolean(),
  serverProfileId: z.string().nullable(),
  model: z.string().nullable(),
  systemPrompt: z.string().nullable(),
  params: ChatParamsSchema,
  enabledTools: z.array(z.string()).nullable(),
  activeLeafId: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type Conversation = z.infer<typeof ConversationSchema>;

export const ConversationPatchSchema = ConversationSchema.pick({
  title: true,
  pinned: true,
  serverProfileId: true,
  model: true,
  systemPrompt: true,
  params: true,
  enabledTools: true,
  activeLeafId: true,
}).partial();
export type ConversationPatch = z.infer<typeof ConversationPatchSchema>;

/** Provider から流れてくるストリーミングイベント */
export const ChatEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text-delta'), text: z.string() }),
  z.object({ type: z.literal('reasoning-delta'), text: z.string() }),
  z.object({ type: z.literal('tool-call'), call: ToolCallSchema }),
  z.object({ type: z.literal('usage'), usage: UsageSchema }),
  z.object({ type: z.literal('done'), finishReason: FinishReasonSchema }),
  z.object({ type: z.literal('error'), message: z.string() }),
  /** ツール承認待ち(renderer は承認カードを出す) */
  z.object({ type: z.literal('tool-approval-request'), call: ToolCallSchema }),
  /** ツール実行の開始・終了(UI の進行表示用) */
  z.object({ type: z.literal('tool-start'), call: ToolCallSchema }),
  z.object({
    type: z.literal('tool-end'),
    callId: z.string(),
    isError: z.boolean(),
    durationMs: z.number(),
  }),
  /** メッセージツリーが変わった(tool メッセージや次の assistant を追加した)ので path を再取得せよ */
  z.object({ type: z.literal('path-changed') }),
  /** run 全体の終了(ツールループを含む)。done はセグメント単位なので別に流す */
  z.object({ type: z.literal('run-end') }),
]);
export type ChatEvent = z.infer<typeof ChatEventSchema>;

/** main -> renderer のチャット進行イベント */
export const ChatRunEventSchema = z.object({
  runId: z.string(),
  conversationId: z.string(),
  messageId: z.string(),
  event: ChatEventSchema,
});
export type ChatRunEvent = z.infer<typeof ChatRunEventSchema>;

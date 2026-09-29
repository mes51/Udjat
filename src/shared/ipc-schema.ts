import { z } from 'zod';
import type { IpcEventChannel, IpcInvokeChannel } from './ipc-channels';
import {
  AttachmentRefSchema,
  AttachmentSchema,
  BackgroundTaskSchema,
  CapabilitiesSchema,
  CapabilityOverridesSchema,
  ChatRunEventSchema,
  ContextUsageSchema,
  ConversationPatchSchema,
  ConversationSchema,
  McpServerInputSchema,
  McpServerSchema,
  McpServerStatusSchema,
  MessageSchema,
  ModelInfoSchema,
  ModelStatusSchema,
  RoleSchema,
  ServerProfileInputSchema,
  ServerProfileSchema,
  ToolApprovalDecisionSchema,
  ToolInfoSchema,
  ToolPolicySchema,
} from './schemas';

/**
 * IPC の入出力スキーマ。main 側で入力を検証し、renderer 側では型として使う。
 * チャネルを追加する時は ipc-channels.ts の配列にも名前を足すこと(型で強制される)。
 */

export const DataDirModeSchema = z.enum(['portable', 'standard', 'dev']);
export type DataDirMode = z.infer<typeof DataDirModeSchema>;

export const AppInfoSchema = z.object({
  name: z.string(),
  version: z.string(),
  dataDir: z.string(),
  dataDirMode: DataDirModeSchema,
  versions: z.object({
    electron: z.string(),
    node: z.string(),
    chrome: z.string(),
    sqlite: z.string(),
  }),
});
export type AppInfo = z.infer<typeof AppInfoSchema>;

const JsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValue),
    z.record(z.string(), JsonValue),
  ]),
);

const Id = z.object({ id: z.string().min(1) });

export const RunHandleSchema = z.object({
  runId: z.string(),
  conversationId: z.string(),
  userMessageId: z.string().nullable(),
  assistantMessageId: z.string(),
});
export type RunHandle = z.infer<typeof RunHandleSchema>;

export const ConnectionTestResultSchema = z.object({
  ok: z.boolean(),
  models: z.array(ModelInfoSchema),
  error: z.string().nullable(),
});
export type ConnectionTestResult = z.infer<typeof ConnectionTestResultSchema>;

export const ipcInvokeSchema = {
  'app:info': { input: z.undefined(), output: AppInfoSchema },
  'settings:get': { input: z.object({ key: z.string().min(1) }), output: JsonValue.nullable() },
  'settings:set': {
    input: z.object({ key: z.string().min(1), value: JsonValue }),
    output: z.undefined(),
  },
  'settings:all': { input: z.undefined(), output: z.record(z.string(), JsonValue) },

  'profiles:list': { input: z.undefined(), output: z.array(ServerProfileSchema) },
  'profiles:create': { input: ServerProfileInputSchema, output: ServerProfileSchema },
  'profiles:update': {
    input: z.object({ id: z.string().min(1), patch: ServerProfileInputSchema.partial() }),
    output: ServerProfileSchema,
  },
  'profiles:delete': { input: Id, output: z.boolean() },
  'profiles:models': {
    input: z.object({ profileId: z.string().min(1) }),
    output: z.array(ModelInfoSchema),
  },
  'profiles:test': { input: ServerProfileInputSchema, output: ConnectionTestResultSchema },
  'models:capabilities': {
    input: z.object({ profileId: z.string().min(1), model: z.string().min(1) }),
    output: CapabilitiesSchema,
  },
  /** サーバーのモデル常駐状態(M10)。非対応なら supported: false */
  'models:status': {
    input: z.object({ profileId: z.string().min(1) }),
    output: ModelStatusSchema,
  },
  'models:load': {
    input: z.object({ profileId: z.string().min(1), model: z.string().min(1) }),
    output: ModelStatusSchema,
  },
  'models:unload': {
    input: z.object({ profileId: z.string().min(1), model: z.string().min(1) }),
    output: ModelStatusSchema,
  },
  /** モデル単位の上書きを保存して、解決後の capability を返す */
  'models:setCapabilities': {
    input: z.object({
      profileId: z.string().min(1),
      model: z.string().min(1),
      overrides: CapabilityOverridesSchema,
    }),
    output: CapabilitiesSchema,
  },

  'conversations:list': { input: z.undefined(), output: z.array(ConversationSchema) },
  'conversations:create': {
    input: z.object({ serverProfileId: z.string().nullable(), model: z.string().nullable() }),
    output: ConversationSchema,
  },
  'conversations:get': { input: Id, output: ConversationSchema.nullable() },
  'conversations:update': {
    input: z.object({ id: z.string().min(1), patch: ConversationPatchSchema }),
    output: ConversationSchema,
  },
  'conversations:delete': { input: Id, output: z.boolean() },

  'messages:path': {
    input: z.object({ conversationId: z.string().min(1) }),
    output: z.array(MessageSchema),
  },
  /** パス上の分岐情報(兄弟が 2 つ以上あるメッセージのみ) */
  'messages:branches': {
    input: z.object({ conversationId: z.string().min(1) }),
    output: z.record(
      z.string(),
      z.object({ index: z.number(), count: z.number(), ids: z.array(z.string()) }),
    ),
  },
  /** 指定した兄弟に切り替える(その配下で最後に作られた葉を active にする) */
  'messages:switchBranch': {
    input: z.object({ conversationId: z.string().min(1), messageId: z.string().min(1) }),
    output: ConversationSchema,
  },
  'messages:search': {
    input: z.object({ query: z.string(), limit: z.number().int().min(1).max(200).optional() }),
    output: z.array(
      z.object({
        messageId: z.string(),
        conversationId: z.string(),
        conversationTitle: z.string(),
        role: RoleSchema,
        createdAt: z.number(),
        snippet: z.string(),
      }),
    ),
  },
  'conversations:export': {
    input: z.object({ id: z.string().min(1), format: z.enum(['markdown', 'json']) }),
    output: z.object({ fileName: z.string(), content: z.string() }),
  },
  /** 保存ダイアログを出してファイルに書く。キャンセルなら null */
  'files:save': {
    input: z.object({ fileName: z.string(), content: z.string() }),
    output: z.string().nullable(),
  },

  'chat:send': {
    input: z.object({
      conversationId: z.string().min(1),
      text: z.string(),
      attachments: z.array(AttachmentRefSchema).optional(),
    }),
    output: RunHandleSchema,
  },
  /** ユーザー発言を編集して、同じ親の下に新しい分岐として送り直す */
  'chat:edit': {
    input: z.object({ messageId: z.string().min(1), text: z.string() }),
    output: RunHandleSchema,
  },
  'chat:regenerate': { input: z.object({ messageId: z.string().min(1) }), output: RunHandleSchema },
  'chat:abort': { input: z.object({ runId: z.string().min(1) }), output: z.boolean() },
  'chat:running': {
    input: z.object({ conversationId: z.string().min(1) }),
    output: z.string().nullable(),
  },
  /** 会話を要約して圧縮する(M14)。要約ノードの id を返す */
  'chat:compact': {
    input: z.object({ conversationId: z.string().min(1) }),
    output: z.object({ messageId: z.string() }),
  },
  'context:usage': {
    input: z.object({ conversationId: z.string().min(1) }),
    output: ContextUsageSchema,
  },

  'tools:list': { input: z.undefined(), output: z.array(ToolInfoSchema) },
  'tools:setPolicy': {
    input: z.object({ name: z.string().min(1), policy: ToolPolicySchema.nullable() }),
    output: z.undefined(),
  },
  'tools:approve': {
    input: z.object({
      runId: z.string().min(1),
      callId: z.string().min(1),
      decision: ToolApprovalDecisionSchema,
      /** 拒否の理由(M15)。モデルに tool 結果として返す */
      reason: z.string().optional(),
    }),
    output: z.boolean(),
  },
  /** バックグラウンドタスク(M16)。conversationId 省略で全会話 */
  'chat:backgroundTasks': {
    input: z.object({ conversationId: z.string().optional() }),
    output: z.array(BackgroundTaskSchema),
  },
  'chat:abortTask': {
    input: z.object({ conversationId: z.string().min(1), callId: z.string().min(1) }),
    output: z.boolean(),
  },

  /** 貼り付け画像や renderer で縮小した画像(base64) */
  'attachments:addBytes': {
    input: z.object({
      name: z.string(),
      mime: z.string().min(1),
      base64: z.string().min(1),
    }),
    output: AttachmentSchema,
  },
  /** ドロップ/選択したファイル(パスは preload の pathForFile で得る) */
  'attachments:addPath': {
    input: z.object({ path: z.string().min(1), name: z.string().optional() }),
    output: AttachmentSchema,
  },
  'attachments:get': { input: Id, output: AttachmentSchema.nullable() },
  /** 添付を「名前を付けて保存」ダイアログで書き出す。キャンセルなら null(M20) */
  'attachments:saveAs': { input: Id, output: z.string().nullable() },
  /** 添付を OS の既定アプリで開く */
  'attachments:open': { input: Id, output: z.boolean() },

  'mcp:list': {
    input: z.undefined(),
    output: z.object({
      servers: z.array(McpServerSchema),
      statuses: z.array(McpServerStatusSchema),
    }),
  },
  'mcp:create': { input: McpServerInputSchema, output: McpServerSchema },
  'mcp:update': {
    input: z.object({ id: z.string().min(1), patch: McpServerInputSchema.partial() }),
    output: McpServerSchema,
  },
  'mcp:delete': { input: Id, output: z.boolean() },
  'mcp:connect': { input: Id, output: McpServerStatusSchema },
  'mcp:disconnect': { input: Id, output: z.undefined() },
  /** Claude Desktop 形式の mcpServers JSON を取り込む。同名は上書き */
  'mcp:importJson': {
    input: z.object({ json: z.string().min(1) }),
    output: z.object({ created: z.number(), updated: z.number() }),
  },
  'mcp:exportJson': { input: z.undefined(), output: z.string() },

  /** ffmpeg / ffprobe の解決結果 */
  'media:binaries': {
    input: z.undefined(),
    output: z.object({
      ffmpeg: z.object({ path: z.string(), available: z.boolean(), custom: z.boolean() }),
      ffprobe: z.object({ path: z.string(), available: z.boolean(), custom: z.boolean() }),
    }),
  },
  /** 設定・プロファイル・MCP サーバー・ツールポリシーをまとめた JSON */
  'settings:exportAll': {
    input: z.object({ includeSecrets: z.boolean() }),
    output: z.string(),
  },
  'settings:importAll': {
    input: z.object({ json: z.string().min(1) }),
    output: z.object({
      settings: z.number(),
      profiles: z.number(),
      mcpServers: z.number(),
      toolPolicies: z.number(),
    }),
  },
  /** ファイルを開くダイアログを出してテキストを読む。キャンセルなら null */
  'files:open': {
    input: z.object({ extensions: z.array(z.string()).optional() }),
    output: z.object({ path: z.string(), content: z.string() }).nullable(),
  },
  /** フォルダ選択ダイアログ。キャンセルなら null */
  'files:pickDirectory': {
    input: z.object({ defaultPath: z.string().optional() }),
    output: z.string().nullable(),
  },
} as const satisfies Record<IpcInvokeChannel, { input: z.ZodType; output: z.ZodType }>;

export const ipcEventSchema = {
  'chat:event': ChatRunEventSchema,
  'mcp:status': McpServerStatusSchema,
} as const satisfies Record<IpcEventChannel, z.ZodType>;

export type IpcInvokeSchema = typeof ipcInvokeSchema;
export type IpcInput<C extends IpcInvokeChannel> = z.input<IpcInvokeSchema[C]['input']>;
export type IpcOutput<C extends IpcInvokeChannel> = z.output<IpcInvokeSchema[C]['output']>;

export type IpcEventSchema = typeof ipcEventSchema;
export type IpcEventPayload<C extends IpcEventChannel> = z.output<IpcEventSchema[C]>;

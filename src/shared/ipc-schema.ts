import { z } from 'zod';
import type { IpcEventChannel, IpcInvokeChannel } from './ipc-channels';
import {
  CapabilitiesSchema,
  ChatRunEventSchema,
  ConversationPatchSchema,
  ConversationSchema,
  MessageSchema,
  ModelInfoSchema,
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
  'messages:search': {
    input: z.object({ query: z.string(), limit: z.number().int().min(1).max(200).optional() }),
    output: z.array(
      z.object({ messageId: z.string(), conversationId: z.string(), snippet: z.string() }),
    ),
  },

  'chat:send': {
    input: z.object({ conversationId: z.string().min(1), text: z.string().min(1) }),
    output: RunHandleSchema,
  },
  'chat:regenerate': { input: z.object({ messageId: z.string().min(1) }), output: RunHandleSchema },
  'chat:abort': { input: z.object({ runId: z.string().min(1) }), output: z.boolean() },
  'chat:running': {
    input: z.object({ conversationId: z.string().min(1) }),
    output: z.string().nullable(),
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
    }),
    output: z.boolean(),
  },
} as const satisfies Record<IpcInvokeChannel, { input: z.ZodType; output: z.ZodType }>;

export const ipcEventSchema = {
  'chat:event': ChatRunEventSchema,
} as const satisfies Record<IpcEventChannel, z.ZodType>;

export type IpcInvokeSchema = typeof ipcInvokeSchema;
export type IpcInput<C extends IpcInvokeChannel> = z.input<IpcInvokeSchema[C]['input']>;
export type IpcOutput<C extends IpcInvokeChannel> = z.output<IpcInvokeSchema[C]['output']>;

export type IpcEventSchema = typeof ipcEventSchema;
export type IpcEventPayload<C extends IpcEventChannel> = z.output<IpcEventSchema[C]>;

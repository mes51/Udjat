import { z } from 'zod';
import type { IpcEventChannel, IpcInvokeChannel } from './ipc-channels';

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

export const ipcInvokeSchema = {
  'app:info': {
    input: z.undefined(),
    output: AppInfoSchema,
  },
  'settings:get': {
    input: z.object({ key: z.string().min(1) }),
    output: JsonValue.nullable(),
  },
  'settings:set': {
    input: z.object({ key: z.string().min(1), value: JsonValue }),
    output: z.undefined(),
  },
  'settings:all': {
    input: z.undefined(),
    output: z.record(z.string(), JsonValue),
  },
} as const satisfies Record<IpcInvokeChannel, { input: z.ZodType; output: z.ZodType }>;

export const ipcEventSchema = {} as const satisfies Record<IpcEventChannel, z.ZodType>;

export type IpcInvokeSchema = typeof ipcInvokeSchema;
export type IpcInput<C extends IpcInvokeChannel> = z.input<IpcInvokeSchema[C]['input']>;
export type IpcOutput<C extends IpcInvokeChannel> = z.output<IpcInvokeSchema[C]['output']>;

export type IpcEventSchema = typeof ipcEventSchema;
export type IpcEventPayload<C extends IpcEventChannel> = z.output<IpcEventSchema[C]>;

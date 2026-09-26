/**
 * IPC チャネル名の一覧。
 * preload はこのファイルだけを import する(zod を preload に持ち込まないため)。
 * 型と検証スキーマは ipc-schema.ts に置く。
 */

/** renderer -> main の invoke/handle チャネル */
export const IPC_INVOKE_CHANNELS = [
  'app:info',
  'settings:get',
  'settings:set',
  'settings:all',
  'profiles:list',
  'profiles:create',
  'profiles:update',
  'profiles:delete',
  'profiles:models',
  'profiles:test',
  'models:capabilities',
  'conversations:list',
  'conversations:create',
  'conversations:get',
  'conversations:update',
  'conversations:delete',
  'messages:path',
  'messages:search',
  'chat:send',
  'chat:regenerate',
  'chat:abort',
  'chat:running',
] as const;

/** main -> renderer の一方向イベントチャネル */
export const IPC_EVENT_CHANNELS = ['chat:event'] as const;

export type IpcInvokeChannel = (typeof IPC_INVOKE_CHANNELS)[number];
export type IpcEventChannel = (typeof IPC_EVENT_CHANNELS)[number];

export function isInvokeChannel(name: string): name is IpcInvokeChannel {
  return (IPC_INVOKE_CHANNELS as readonly string[]).includes(name);
}

export function isEventChannel(name: string): name is IpcEventChannel {
  return (IPC_EVENT_CHANNELS as readonly string[]).includes(name);
}

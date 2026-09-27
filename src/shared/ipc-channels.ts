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
  'models:setCapabilities',
  'models:status',
  'models:load',
  'models:unload',
  'conversations:list',
  'conversations:create',
  'conversations:get',
  'conversations:update',
  'conversations:delete',
  'messages:path',
  'messages:branches',
  'messages:switchBranch',
  'messages:search',
  'conversations:export',
  'files:save',
  'chat:send',
  'chat:edit',
  'chat:regenerate',
  'chat:abort',
  'chat:running',
  'tools:list',
  'tools:setPolicy',
  'tools:approve',
  'attachments:addBytes',
  'attachments:addPath',
  'attachments:get',
  'mcp:list',
  'mcp:create',
  'mcp:update',
  'mcp:delete',
  'mcp:connect',
  'mcp:disconnect',
  'mcp:importJson',
  'mcp:exportJson',
  'media:binaries',
  'settings:exportAll',
  'settings:importAll',
  'files:open',
  'files:pickDirectory',
] as const;

/** main -> renderer の一方向イベントチャネル */
export const IPC_EVENT_CHANNELS = ['chat:event', 'mcp:status'] as const;

export type IpcInvokeChannel = (typeof IPC_INVOKE_CHANNELS)[number];
export type IpcEventChannel = (typeof IPC_EVENT_CHANNELS)[number];

export function isInvokeChannel(name: string): name is IpcInvokeChannel {
  return (IPC_INVOKE_CHANNELS as readonly string[]).includes(name);
}

export function isEventChannel(name: string): name is IpcEventChannel {
  return (IPC_EVENT_CHANNELS as readonly string[]).includes(name);
}

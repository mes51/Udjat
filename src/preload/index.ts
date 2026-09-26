import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { isEventChannel, isInvokeChannel } from '@shared/ipc-channels';

/**
 * renderer に公開する最小 API。チャネル名はホワイトリストで検査し、
 * 型付けは renderer 側の lib/ipc.ts で行う(preload には zod を持ち込まない)。
 */
const api = {
  invoke(channel: string, input?: unknown): Promise<unknown> {
    if (!isInvokeChannel(channel)) {
      return Promise.reject(new Error(`unknown ipc channel: ${channel}`));
    }
    return ipcRenderer.invoke(channel, input);
  },
  on(channel: string, listener: (payload: unknown) => void): () => void {
    if (!isEventChannel(channel)) {
      throw new Error(`unknown ipc event channel: ${channel}`);
    }
    const wrapped = (_e: IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },
};

export type UdjatBridge = typeof api;

contextBridge.exposeInMainWorld('udjat', api);

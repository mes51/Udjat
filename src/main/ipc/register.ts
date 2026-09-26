import { BrowserWindow, ipcMain } from 'electron';
import type { IpcEventChannel, IpcInvokeChannel } from '@shared/ipc-channels';
import {
  ipcEventSchema,
  ipcInvokeSchema,
  type IpcEventPayload,
  type IpcInput,
  type IpcOutput,
} from '@shared/ipc-schema';

type Handler<C extends IpcInvokeChannel> = (
  input: IpcInput<C>,
) => IpcOutput<C> | Promise<IpcOutput<C>>;

/**
 * 型付き ipcMain.handle。入力は zod で検証してからハンドラに渡す。
 * 検証エラーは renderer 側に Error として伝わる。
 */
export function handleIpc<C extends IpcInvokeChannel>(channel: C, handler: Handler<C>): void {
  const schema = ipcInvokeSchema[channel];
  ipcMain.handle(channel, async (_event, raw: unknown) => {
    const parsed = schema.input.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`invalid input for ${channel}: ${parsed.error.message}`);
    }
    return handler(parsed.data as IpcInput<C>);
  });
}

/** 型付き main -> renderer イベント送信(全ウィンドウへ)。 */
export function broadcastIpcEvent<C extends IpcEventChannel>(
  channel: C,
  payload: IpcEventPayload<C>,
): void {
  const schema = ipcEventSchema[channel] as { parse(v: unknown): unknown };
  schema.parse(payload);
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

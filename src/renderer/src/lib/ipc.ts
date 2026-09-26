import type { IpcEventChannel, IpcInvokeChannel } from '@shared/ipc-channels';
import type { IpcEventPayload, IpcInput, IpcOutput } from '@shared/ipc-schema';

/** preload が公開した window.udjat を型付きで包む。 */

type InvokeArgs<C extends IpcInvokeChannel> =
  IpcInput<C> extends undefined ? [] : [input: IpcInput<C>];

export function invoke<C extends IpcInvokeChannel>(
  channel: C,
  ...args: InvokeArgs<C>
): Promise<IpcOutput<C>> {
  return window.udjat.invoke(channel, args[0]) as Promise<IpcOutput<C>>;
}

export function onEvent<C extends IpcEventChannel>(
  channel: C,
  listener: (payload: IpcEventPayload<C>) => void,
): () => void {
  return window.udjat.on(channel, listener as (payload: unknown) => void);
}

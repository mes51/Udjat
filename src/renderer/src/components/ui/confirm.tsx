import { AlertDialog } from 'radix-ui';
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';
import { Button } from './button';

/**
 * window.confirm の代替。Electron の renderer で confirm()/alert() を使うと、
 * ダイアログを閉じた後にキー入力が効かなくなる不具合があるため、アプリ内ダイアログで確認する。
 */

interface ConfirmOptions {
  title: string;
  description?: string;
  confirmLabel?: string;
  danger?: boolean;
}

const ConfirmContext = createContext<((opts: ConfirmOptions) => Promise<boolean>) | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback((o: ConfirmOptions) => {
    return new Promise<boolean>((resolve) => {
      resolver.current?.(false);
      resolver.current = resolve;
      setOpts(o);
    });
  }, []);

  const finish = (v: boolean) => {
    resolver.current?.(v);
    resolver.current = null;
    setOpts(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog.Root open={opts !== null} onOpenChange={(open) => !open && finish(false)}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px]" />
          <AlertDialog.Content className="bg-surface-2 border-border shadow-overlay fixed top-1/2 left-1/2 z-50 w-[min(92vw,26rem)] -translate-x-1/2 -translate-y-1/2 rounded-lg border p-5 focus:outline-none">
            <AlertDialog.Title className="text-base font-semibold">{opts?.title}</AlertDialog.Title>
            <AlertDialog.Description className="text-fg-muted mt-1 text-sm">
              {opts?.description ?? ''}
            </AlertDialog.Description>
            <div className="mt-4 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <Button variant="secondary">キャンセル</Button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <Button variant={opts?.danger ? 'danger' : 'default'} onClick={() => finish(true)}>
                  {opts?.confirmLabel ?? 'OK'}
                </Button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </ConfirmContext.Provider>
  );
}

export function useConfirm(): (opts: ConfirmOptions) => Promise<boolean> {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm は ConfirmProvider の中で使ってください');
  return ctx;
}

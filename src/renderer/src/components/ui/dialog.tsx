import { Dialog as RadixDialog } from 'radix-ui';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@renderer/lib/utils';
import { Button } from './button';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
  /**
   * 左に置くナビ(設定画面のように区画が多い時)。指定すると高さを固定した 2 カラムになり、
   * 右側だけがスクロールする。
   */
  aside?: ReactNode;
}

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  className,
  aside,
}: DialogProps) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-40 bg-black/55 backdrop-blur-[2px]" />
        <RadixDialog.Content
          // 開いた直後に閉じるボタンへフォーカスが移ってリングが目立つのを避ける
          onOpenAutoFocus={(e) => e.preventDefault()}
          className={cn(
            'bg-surface-2 border-border shadow-overlay fixed top-1/2 left-1/2 z-50 flex -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border focus:outline-none',
            aside ? 'h-[min(90vh,56rem)] w-[min(94vw,64rem)]' : 'max-h-[85vh] w-[min(92vw,56rem)]',
            className,
          )}
        >
          <div className="border-border flex items-start justify-between border-b px-5 py-3">
            <div>
              <RadixDialog.Title className="text-base font-semibold">{title}</RadixDialog.Title>
              {description ? (
                <RadixDialog.Description className="text-fg-muted mt-0.5 text-xs">
                  {description}
                </RadixDialog.Description>
              ) : (
                <RadixDialog.Description className="sr-only">{title}</RadixDialog.Description>
              )}
            </div>
            <RadixDialog.Close asChild>
              <Button variant="ghost" size="icon" aria-label="閉じる">
                <X size={16} />
              </Button>
            </RadixDialog.Close>
          </div>
          {aside ? (
            <div className="flex min-h-0 flex-1">
              <nav className="border-border bg-surface w-44 shrink-0 overflow-y-auto border-r px-2 py-3">
                {aside}
              </nav>
              <div className="min-h-0 flex-1 overflow-auto px-6 py-5">{children}</div>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto px-5 py-4">{children}</div>
          )}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

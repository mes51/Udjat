import type { ReactNode } from 'react';
import { cn } from '@renderer/lib/utils';

/**
 * 設定画面・ドロワーの区画見出し。左に小さな見出し、右に補助操作(任意)。
 * 使い方は docs/design/components.md「区画と見出し」。
 */
export function SectionTitle({
  children,
  action,
  description,
  className,
}: {
  children: ReactNode;
  action?: ReactNode;
  description?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('mb-2', className)}>
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-fg-muted text-xs font-medium tracking-wide">{children}</h4>
        {action}
      </div>
      {description && (
        <p className="text-fg-subtle mt-0.5 text-[11px] leading-snug">{description}</p>
      )}
    </div>
  );
}

/** 区画のまとまり。gap で縦に積む */
export function Section({ className, children }: { className?: string; children: ReactNode }) {
  return <section className={cn('flex flex-col', className)}>{children}</section>;
}

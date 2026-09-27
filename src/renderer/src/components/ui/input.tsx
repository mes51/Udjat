import type { ComponentProps, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { cn } from '@renderer/lib/utils';

/**
 * フォーム部品。パネル(surface-2)の上に置く前提で、地(surface)の色を敷いて凹ませる。
 * フォーカスはアクセントの枠線 + 薄いリング。使い分けは docs/design/components.md。
 */
const base =
  'w-full rounded-sm border border-border bg-surface px-2.5 py-1.5 text-sm text-fg transition-colors placeholder:text-fg-subtle hover:border-border-strong focus-visible:border-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/25 disabled:opacity-50';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input className={cn(base, 'h-8', className)} {...props} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea className={cn(base, 'min-h-20 resize-y leading-relaxed', className)} {...props} />
  );
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(base, 'ui-select h-8 appearance-none pr-8', className)} {...props}>
      {children}
    </select>
  );
}

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label className={cn('text-fg-muted mb-1 block text-xs font-medium', className)} {...props} />
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string | undefined;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Label>{label}</Label>
      {children}
      {hint && <p className="text-fg-subtle mt-1 text-[11px] leading-snug">{hint}</p>}
    </div>
  );
}

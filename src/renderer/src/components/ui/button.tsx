import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '@renderer/lib/utils';

/**
 * ボタン。使い分けは docs/design/components.md。
 * - default: 画面に 1 つの主操作(送信・保存・許可)
 * - secondary: 並列の操作(接続テスト・書き出し)
 * - outline: 補助的な操作を枠線だけで示す
 * - ghost: アイコンボタンや行内の操作。背景は hover 時だけ
 * - danger: 取り消せない操作(削除・拒否)
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-1.5 rounded-md text-sm font-medium whitespace-nowrap transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 focus-visible:ring-offset-1 focus-visible:ring-offset-surface disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        default: 'bg-accent text-accent-fg hover:bg-accent-strong',
        secondary: 'bg-surface-4 text-fg border border-border-strong hover:brightness-110',
        outline: 'border border-border-strong text-fg hover:bg-surface-3',
        ghost: 'text-fg-muted hover:bg-surface-3 hover:text-fg',
        danger: 'bg-danger/12 text-danger border border-danger/30 hover:bg-danger/20',
      },
      size: {
        default: 'h-8 px-3',
        sm: 'h-7 px-2 text-xs',
        icon: 'h-8 w-8',
        'icon-sm': 'h-6 w-6',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, type = 'button', ...props }: ButtonProps) {
  return (
    <button type={type} className={cn(buttonVariants({ variant, size }), className)} {...props} />
  );
}

import type { ComponentProps } from 'react';
import { cn } from '@renderer/lib/utils';

/**
 * スライダー。数値入力と並べて使う(docs/design/components.md「スライダー付き数値」)。
 * 見た目は index.css の input[type='range'] で、アクセント色のつまみ + 面の色のトラック。
 */
export function Range({ className, ...props }: ComponentProps<'input'>) {
  return (
    <input
      type="range"
      className={cn('ui-range w-full cursor-pointer disabled:cursor-default', className)}
      {...props}
    />
  );
}

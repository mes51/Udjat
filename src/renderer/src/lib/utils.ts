import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function formatRelativeTime(ts: number, now = Date.now()): string {
  const diff = now - ts;
  const min = 60_000;
  if (diff < min) return 'たった今';
  if (diff < 60 * min) return `${Math.floor(diff / min)} 分前`;
  if (diff < 24 * 60 * min) return `${Math.floor(diff / (60 * min))} 時間前`;
  const d = new Date(ts);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

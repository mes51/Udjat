import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/**
 * モデル id の表示名。llama.cpp はファイルのフルパスを id に使うので末尾だけにし、
 * Unsloth の "repo/name:QUANT" は "name (QUANT)" にする。
 */
export function modelDisplayName(id: string | null | undefined): string {
  if (!id) return '';
  let base = id;
  let quant: string | null = null;
  const colon = id.lastIndexOf(':');
  if (colon > 0 && /^[A-Za-z0-9_.-]+$/.test(id.slice(colon + 1)) && !/^[A-Za-z]:[\\/]/.test(id)) {
    base = id.slice(0, colon);
    quant = id.slice(colon + 1);
  }
  const name = base.split(/[\\/]/).pop() || base;
  return quant ? `${name} (${quant})` : name;
}

/** バイト数を "12.3 MB" のように */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
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

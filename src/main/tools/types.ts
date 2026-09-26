import type { Capabilities, ToolPolicy } from '@shared/schemas';
import type { ToolDefinition } from '@main/providers';

/** ツール実行時に渡すコンテキスト */
export interface ToolContext {
  conversationId: string;
  runId: string;
  signal: AbortSignal;
  /** 1 回の run 内でのカウンタ(検索回数の上限など) */
  counters: Map<string, number>;
  /** settings テーブルの読み出し */
  getSetting: (key: string) => unknown;
}

export interface ToolMedia {
  mime: string;
  /** MediaStore 上のパス(M3 で使用) */
  path: string;
  label?: string;
}

export interface ToolResult {
  /** モデルに返す本文(JSON 文字列でも可) */
  text: string;
  media?: ToolMedia[];
  isError?: boolean;
}

export type ToolSource = { kind: 'builtin' } | { kind: 'mcp'; serverId: string };

export interface RegisteredTool {
  definition: ToolDefinition;
  source: ToolSource;
  /** 既定の承認ポリシー(tool_policies テーブルで上書き可) */
  defaultPolicy: ToolPolicy;
  /** この capability を満たさない時は提供しない */
  requires?: Partial<Capabilities>;
  execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
}

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export function ok(text: string, media?: ToolMedia[]): ToolResult {
  const r: ToolResult = { text };
  if (media && media.length > 0) r.media = media;
  return r;
}

export function fail(message: string): ToolResult {
  return { text: `error: ${message}`, isError: true };
}

export function str(args: Record<string, unknown>, key: string, fallback?: string): string {
  const v = args[key];
  if (typeof v === 'string' && v.trim() !== '') return v;
  if (fallback !== undefined) return fallback;
  throw new ToolError(`引数 ${key} は必須の文字列です`);
}

export function num(
  args: Record<string, unknown>,
  key: string,
  fallback: number,
  min?: number,
  max?: number,
): number {
  const v = args[key];
  let n =
    typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : fallback;
  if (!Number.isFinite(n)) n = fallback;
  if (min !== undefined) n = Math.max(min, n);
  if (max !== undefined) n = Math.min(max, n);
  return n;
}

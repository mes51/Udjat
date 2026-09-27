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

/** ツールが返す画像・動画。添付として登録済みのものを id で指す */
export interface ToolMedia {
  attachmentId: string;
  mime: string;
  kind: 'image' | 'video';
  label: string;
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
  /** カテゴリ id(組み込み: basic / web / video / pdf / code、MCP: "mcp:<serverId>") */
  category: string;
  /** カテゴリの表示名(組み込みは省略可、MCP はサーバー名) */
  categoryLabel?: string;
  /** 既定の承認ポリシー(tool_policies テーブルで上書き可) */
  defaultPolicy: ToolPolicy;
  /** この capability を満たさない時は提供しない */
  requires?: Partial<Capabilities>;
  /**
   * 引数を見て「ポリシーや会話単位の常時許可に関わらず承認が必要」と判定する
   * (例: run_javascript がファイル/ネットワーク権限を宣言した時)
   */
  requiresApproval?: (args: Record<string, unknown>) => boolean;
  /**
   * 今は使えない理由を返す(使える時は null)。理由がある間はモデルに定義を渡さず、
   * UI では灰色表示にする(例: ファイルツールで許可フォルダが未設定)
   */
  unavailable?: () => string | null;
  /**
   * 引数を見て「最初からバックグラウンドタスクとして実行する」と判定する(M16)。
   * 判定しなくても、実行が設定 tools.backgroundAfterMs を超えれば切り離される
   */
  background?: (args: Record<string, unknown>) => boolean;
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

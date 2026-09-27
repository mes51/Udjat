import type { ToolInfo } from '@shared/schemas';
import { BUILTIN_TOOL_CATEGORIES } from '@shared/schemas';

export interface ToolCategory {
  id: string;
  label: string;
  tools: ToolInfo[];
  /** カテゴリの全ツールが今使えない時、その理由(例: 許可フォルダ未設定) */
  unavailable?: string;
}

/** ツール一覧をカテゴリごとにまとめる。組み込みは定義順、MCP サーバーはその後に名前順 */
export function groupToolsByCategory(tools: ToolInfo[]): ToolCategory[] {
  const map = new Map<string, ToolCategory>();
  for (const t of tools) {
    let c = map.get(t.category);
    if (!c) {
      c = { id: t.category, label: t.categoryLabel, tools: [] };
      map.set(t.category, c);
    }
    c.tools.push(t);
  }
  for (const c of map.values()) {
    const reason = c.tools[0]?.unavailable;
    if (reason && c.tools.every((t) => t.unavailable)) c.unavailable = reason;
  }
  const order = (id: string) => {
    const i = (BUILTIN_TOOL_CATEGORIES as readonly string[]).indexOf(id);
    return i === -1 ? BUILTIN_TOOL_CATEGORIES.length : i;
  };
  return [...map.values()].sort(
    (a, b) => order(a.id) - order(b.id) || a.label.localeCompare(b.label, 'ja'),
  );
}

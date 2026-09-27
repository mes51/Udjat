import type { Capabilities, ToolFilter, ToolInfo, ToolPolicy } from '@shared/schemas';
import { TOOL_CATEGORY_LABELS } from '@shared/schemas';
import type { ToolDefinition } from '@main/providers';
import type { Database } from '@main/db/client';
import type { RegisteredTool, ToolContext, ToolResult } from './types';
import { ToolError } from './types';

const EMPTY_FILTER: ToolFilter = { disabledCategories: [], disabledTools: [] };

function categoryLabelOf(t: RegisteredTool): string {
  if (t.categoryLabel) return t.categoryLabel;
  return (TOOL_CATEGORY_LABELS as Record<string, string>)[t.category] ?? t.category;
}

/**
 * ツール定義の集約。組み込みツールと MCP ツール(M5)を同じ形で扱う。
 * 承認ポリシーは tool_policies テーブルで永続化し、無ければ各ツールの既定を使う。
 */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  constructor(private readonly db: Database) {}

  register(tool: RegisteredTool): void {
    if (this.tools.has(tool.definition.name)) {
      throw new Error(`tool already registered: ${tool.definition.name}`);
    }
    this.tools.set(tool.definition.name, tool);
  }

  unregister(name: string): void {
    this.tools.delete(name);
  }

  unregisterBySource(pred: (source: RegisteredTool['source']) => boolean): void {
    for (const [name, t] of [...this.tools]) if (pred(t.source)) this.tools.delete(name);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  list(): ToolInfo[] {
    return [...this.tools.values()].map((t) => ({
      name: t.definition.name,
      description: t.definition.description,
      source: t.source.kind,
      policy: this.policyFor(t.definition.name),
      category: t.category,
      categoryLabel: categoryLabelOf(t),
    }));
  }

  policyFor(name: string): ToolPolicy {
    const row = this.db
      .prepare('SELECT policy FROM tool_policies WHERE tool_name = ?')
      .get(name) as { policy: ToolPolicy } | undefined;
    if (row) return row.policy;
    return this.tools.get(name)?.defaultPolicy ?? 'ask';
  }

  setPolicy(name: string, policy: ToolPolicy | null): void {
    if (policy === null) {
      this.db.prepare('DELETE FROM tool_policies WHERE tool_name = ?').run(name);
      return;
    }
    this.db
      .prepare(
        'INSERT INTO tool_policies (tool_name, policy) VALUES (?, ?) ON CONFLICT(tool_name) DO UPDATE SET policy = excluded.policy',
      )
      .run(name, policy);
  }

  /**
   * モデルに渡すツール定義。capability を満たさないもの、ポリシー deny のもの、
   * 会話で無効化されたカテゴリ・ツールを除く。
   */
  definitionsFor(capabilities: Capabilities, filter: ToolFilter = EMPTY_FILTER): ToolDefinition[] {
    const out: ToolDefinition[] = [];
    for (const t of this.tools.values()) {
      if (filter.disabledCategories.includes(t.category)) continue;
      if (filter.disabledTools.includes(t.definition.name)) continue;
      if (this.policyFor(t.definition.name) === 'deny') continue;
      if (t.requires && !satisfies(capabilities, t.requires)) continue;
      out.push(t.definition);
    }
    return out;
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const tool = this.tools.get(name);
    if (!tool) return { text: `error: unknown tool ${name}`, isError: true };
    try {
      return await tool.execute(args, ctx);
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      const msg =
        e instanceof ToolError ? e.message : `${(e as Error).name}: ${(e as Error).message}`;
      return { text: `error: ${msg}`, isError: true };
    }
  }
}

function satisfies(caps: Capabilities, req: Partial<Capabilities>): boolean {
  for (const [k, v] of Object.entries(req)) {
    if (v !== undefined && (caps as unknown as Record<string, unknown>)[k] !== v) return false;
  }
  return true;
}

/** モデルが返した引数文字列をオブジェクトにする。壊れていれば空オブジェクト + エラー文 */
export function parseToolArgs(raw: string): { args: Record<string, unknown>; error?: string } {
  const s = raw.trim();
  if (s === '') return { args: {} };
  try {
    const v = JSON.parse(s) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v))
      return { args: v as Record<string, unknown> };
    return { args: {}, error: 'arguments must be a JSON object' };
  } catch (e) {
    return { args: {}, error: `invalid JSON arguments: ${(e as Error).message}` };
  }
}

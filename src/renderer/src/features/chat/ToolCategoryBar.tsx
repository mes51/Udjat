import { Plug, Wrench } from 'lucide-react';
import type { Conversation } from '@shared/schemas';
import { useConversationMutations, useSettingMutation, useTools } from '@renderer/lib/queries';
import { groupToolsByCategory } from '@renderer/lib/tools';
import { cn } from '@renderer/lib/utils';

/**
 * カテゴリの ON/OFF。会話に保存し、同時に「次の会話の既定」としても記憶する。
 * 入力欄のチップと会話設定パネルの両方から使う。
 */
export function useToolCategoryToggle(conversation: Conversation) {
  const { update } = useConversationMutations();
  const saveSetting = useSettingMutation();
  return (categoryId: string) => {
    const cur = conversation.disabledCategories;
    const next = cur.includes(categoryId)
      ? cur.filter((x) => x !== categoryId)
      : [...cur, categoryId];
    update.mutate({ id: conversation.id, patch: { disabledCategories: next } });
    saveSetting.mutate({ key: 'tools.defaultDisabledCategories', value: next });
  };
}

/** 入力欄の上に出すカテゴリ別トグル */
export function ToolCategoryBar({
  conversation,
  toolsSupported,
}: {
  conversation: Conversation;
  /** 選択中モデルがツール呼び出しに対応していると推定されているか */
  toolsSupported: boolean;
}) {
  const tools = useTools();
  const toggle = useToolCategoryToggle(conversation);
  const cats = groupToolsByCategory(tools.data ?? []);
  if (cats.length === 0) return null;
  if (!toolsSupported) {
    return (
      <div className="text-fg-muted flex items-center gap-1 px-1 pb-1.5 text-[11px]">
        <Wrench size={11} />{' '}
        このモデルはツール呼び出し非対応と推定されているため、ツールは送りません
      </div>
    );
  }
  const disabled = new Set(conversation.disabledCategories);
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-1 pb-1.5" aria-label="ツールのカテゴリ">
      <Wrench size={12} className="text-fg-muted" />
      {cats.map((c) => {
        const on = !disabled.has(c.id);
        const active = c.tools.filter(
          (t) => t.policy !== 'deny' && !conversation.disabledTools.includes(t.name),
        ).length;
        const partial = on && active < c.tools.length;
        const names = c.tools.map((t) => t.name).join(', ');
        return (
          <button
            key={c.id}
            type="button"
            aria-pressed={on}
            title={
              c.unavailable ? `${c.unavailable}: ${names}` : `${on ? '有効' : '無効'}: ${names}`
            }
            onClick={() => toggle(c.id)}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors',
              on && !c.unavailable
                ? 'border-accent/60 bg-accent/15 text-fg hover:bg-accent/25'
                : 'border-border text-fg-muted hover:bg-surface-3 opacity-70',
              on && c.unavailable && 'border-dashed',
            )}
          >
            {c.id.startsWith('mcp:') && <Plug size={10} />}
            {c.label}
            {partial && (
              <span className="text-fg-muted tabular-nums">
                {active}/{c.tools.length}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

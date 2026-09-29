import { Loader2, Plug, PlugZap, Wrench } from 'lucide-react';
import type { Conversation } from '@shared/schemas';
import {
  useConversationMutations,
  useMcpConnectMutation,
  useMcpServers,
  useSettingMutation,
  useTools,
} from '@renderer/lib/queries';
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
  // 有効なのに未接続の MCP サーバーは、設定画面へ行かずにここから接続できる(M21)
  const mcp = useMcpServers();
  const connect = useMcpConnectMutation();
  const offline = (mcp.data?.servers ?? [])
    .filter((s) => s.enabled)
    .map((s) => ({ server: s, status: mcp.data?.statuses.find((st) => st.id === s.id) }))
    // 接続中も出しておく(HTTP の接続失敗は判明まで数十秒かかり、その間チップが消えると再試行できないように見える)
    .filter(({ status }) => !status || status.state !== 'connected');
  if (cats.length === 0 && offline.length === 0) return null;
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
      {offline.map(({ server, status }) => {
        const connecting =
          (connect.isPending && connect.variables === server.id) || status?.state === 'connecting';
        const error = status?.state === 'error' ? status.error : null;
        return (
          <button
            key={`mcp-offline-${server.id}`}
            type="button"
            disabled={connecting}
            title={
              error
                ? `接続に失敗しました: ${error}。クリックで再接続`
                : 'MCP サーバーが未接続です。クリックで接続'
            }
            onClick={() => connect.mutate(server.id)}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border border-dashed px-2 py-0.5 text-[11px] transition-colors',
              error
                ? 'border-danger/60 text-danger hover:bg-danger/10'
                : 'border-border text-fg-muted hover:bg-surface-3',
            )}
          >
            {connecting ? <Loader2 size={10} className="animate-spin" /> : <PlugZap size={10} />}
            {server.name}
            <span className="opacity-70">
              {connecting ? '接続中…' : error ? 'エラー' : '未接続'}
            </span>
          </button>
        );
      })}
    </div>
  );
}

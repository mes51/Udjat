import { Gauge, Loader2, Shrink } from 'lucide-react';
import { Button } from '@renderer/components/ui/button';
import { useConfirm } from '@renderer/components/ui/confirm';
import { useCompactMutation, useContextUsage } from '@renderer/lib/queries';
import { cn } from '@renderer/lib/utils';
import { useStreamStore } from '@renderer/state/stream-store';

/** 1234 -> "1.2k"、123456 -> "123k" */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** 使用率に応じた色。80% で warning、95% で danger */
export function usageTone(percent: number | null): 'normal' | 'warning' | 'danger' {
  if (percent === null) return 'normal';
  return percent >= 95 ? 'danger' : percent >= 80 ? 'warning' : 'normal';
}

/**
 * ヘッダーのコンテキストメーター(M14)。直近の usage + 推定分 / 上限を出し、押すと要約圧縮できる。
 */
export function ContextMeter({
  conversationId,
  running,
}: {
  conversationId: string;
  running: boolean;
}) {
  const usage = useContextUsage(conversationId);
  const compact = useCompactMutation(conversationId);
  const confirm = useConfirm();
  const compacting = useStreamStore((s) => s.compacting[conversationId]) || compact.isPending;
  const u = usage.data;
  if (!u) return null;
  const percent = u.limit ? Math.min(100, Math.round((u.used / u.limit) * 100)) : null;
  const tone = usageTone(percent);
  const detail = [
    u.measured !== null
      ? `直近の応答時点: ${u.measured.toLocaleString()} トークン(サーバー計測)`
      : 'サーバー計測なし(全て推定)',
    u.estimated > 0 ? `その後の推定分: +${u.estimated.toLocaleString()}` : null,
    u.limit
      ? `上限 ${u.limit.toLocaleString()}(${u.limitSource === 'params' ? 'パラメータ指定' : 'サーバー申告'})`
      : '上限は不明(サーバーが申告しないか未取得)',
    `モデルに送る範囲: ${u.messagesInContext} 件${u.compacted ? '(要約済み)' : ''}`,
    'クリックで会話を要約して圧縮します',
  ]
    .filter(Boolean)
    .join('\n');

  const onCompact = async () => {
    const ok = await confirm({
      title: '会話を要約して圧縮しますか?',
      description:
        'ここまでの会話をモデルに要約させ、以後はその要約だけを送ります。表示は残り、圧縮前の応答の「ここから分岐」から元の履歴で続けることもできます。',
      confirmLabel: '圧縮する',
    });
    if (ok) compact.mutate();
  };

  return (
    <span className="flex min-w-0 items-center gap-1.5 text-xs" aria-label="コンテキスト使用量">
      {compacting ? (
        <span className="text-fg-muted flex items-center gap-1" role="status">
          <Loader2 size={13} className="animate-spin" /> 要約中…
        </span>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5 px-1.5"
          title={detail}
          disabled={running}
          onClick={() => void onCompact()}
          aria-label={`コンテキスト ${formatTokens(u.used)}${u.limit ? ` / ${formatTokens(u.limit)}` : ''}`}
        >
          <Gauge size={13} className="text-fg-muted" />
          <span
            className={cn(
              'tabular-nums',
              tone === 'danger' && 'text-danger',
              tone === 'warning' && 'text-warning',
            )}
          >
            {formatTokens(u.used)}
            {u.limit ? ` / ${formatTokens(u.limit)}` : ''}
          </span>
          {percent !== null && (
            <span
              className="bg-surface-4 relative h-1.5 w-14 overflow-hidden rounded-full"
              aria-hidden
            >
              <span
                className={cn(
                  'absolute inset-y-0 left-0 rounded-full',
                  tone === 'danger' ? 'bg-danger' : tone === 'warning' ? 'bg-warning' : 'bg-accent',
                )}
                style={{ width: `${percent}%` }}
              />
            </span>
          )}
          {u.compacted && <Shrink size={12} className="text-fg-muted" aria-label="要約済み" />}
        </Button>
      )}
      {compact.error && (
        <span className="max-w-56 truncate text-danger" title={String(compact.error)}>
          圧縮に失敗: {String(compact.error)}
        </span>
      )}
    </span>
  );
}

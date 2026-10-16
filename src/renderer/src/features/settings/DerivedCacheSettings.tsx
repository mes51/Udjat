import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@renderer/components/ui/button';
import { useDerivedStats, useEvictDerivedMutation } from '@renderer/lib/queries';
import { formatBytes } from '@renderer/lib/utils';

/**
 * 派生物(動画のフレーム、コンタクトシート、クリップ、PDF のページ画像など)のキャッシュ(M23)。
 * ファイルを消しても会話の記録は残り、表示やモデルへの送信で必要になれば元の添付から作り直す。
 * conversationId があればその会話の分だけ、無ければ全体を扱う。
 */
export function DerivedCachePanel({ conversationId }: { conversationId?: string }) {
  const stats = useDerivedStats(conversationId);
  const evict = useEvictDerivedMutation();
  const [done, setDone] = useState<string | null>(null);
  const s = stats.data;
  const label = conversationId ? 'この会話のフレーム等' : 'フレーム等の合計';
  return (
    <div className="flex flex-col gap-1.5 text-xs">
      <div className="flex items-center gap-2">
        <span className="text-fg-muted min-w-0 flex-1">
          {s
            ? `${label}: ${s.count} 件 · ${formatBytes(s.bytes)}${s.evicted > 0 ? `(うち ${s.evicted} 件は削除済み)` : ''}`
            : '読み込み中…'}
        </span>
        <Button
          variant="secondary"
          size="sm"
          disabled={!s || s.count - s.evicted === 0 || evict.isPending}
          onClick={() =>
            evict.mutate(conversationId, {
              onSuccess: (r) => setDone(`${r.count} 件(${formatBytes(r.bytes)})を削除しました`),
            })
          }
        >
          <Trash2 size={12} /> {conversationId ? '削除' : 'すべて削除'}
        </Button>
      </div>
      {done && <span className="text-fg-subtle">{done}</span>}
      {evict.isError && <span className="text-danger">{String(evict.error)}</span>}
    </div>
  );
}

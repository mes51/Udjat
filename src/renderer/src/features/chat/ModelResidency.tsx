import { Loader2 } from 'lucide-react';
import { Button } from '@renderer/components/ui/button';
import { useModelLoadMutations, useModelStatus } from '@renderer/lib/queries';
import { cn } from '@renderer/lib/utils';
import { useStreamStore } from '@renderer/state/stream-store';

/**
 * ヘッダーのモデル常駐表示(M10)。対応サーバー(Unsloth / llama.cpp router / LM Studio)でだけ出る。
 * 送信直前の自動ロード中は進行表示に切り替わる。
 */
export function ModelResidency({
  profileId,
  model,
  conversationId,
}: {
  profileId: string | null;
  model: string | null;
  conversationId: string;
}) {
  const status = useModelStatus(profileId);
  const { load, unload } = useModelLoadMutations(profileId);
  const loadingForRun = useStreamStore((s) => s.modelLoading[conversationId]);

  if (loadingForRun) {
    return (
      <span className="text-fg-muted flex items-center gap-1 text-xs" role="status">
        <Loader2 size={14} className="animate-spin" /> モデルを読み込み中: {loadingForRun}
      </span>
    );
  }
  if (!profileId || !model || !status.data?.supported) return null;
  const isLoaded = status.data.loaded.includes(model);
  const isLoading = status.data.loading.includes(model) || load.isPending;
  const error = load.error ?? unload.error;
  return (
    <span className="flex min-w-0 items-center gap-1 text-xs" aria-label="モデルの常駐状態">
      <span
        className={cn(
          'inline-block h-2 w-2 shrink-0 rounded-full',
          isLoaded ? 'bg-emerald-400' : isLoading ? 'animate-pulse bg-amber-400' : 'bg-fg-muted/40',
        )}
      />
      <span className="text-fg-muted">
        {isLoaded ? '常駐' : isLoading ? 'ロード中' : '未ロード'}
      </span>
      {isLoaded ? (
        <Button
          variant="ghost"
          size="sm"
          disabled={unload.isPending}
          onClick={() => unload.mutate(model)}
          title="サーバーからこのモデルをアンロードする"
        >
          {unload.isPending ? <Loader2 size={12} className="animate-spin" /> : null} アンロード
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          disabled={isLoading}
          onClick={() => load.mutate(model)}
          title="サーバーにこのモデルをロードする(送信時にも自動でロードされます)"
        >
          {isLoading ? <Loader2 size={12} className="animate-spin" /> : null} ロード
        </Button>
      )}
      {error && (
        <span className="max-w-56 truncate text-red-400" title={String(error)}>
          失敗: {String(error)}
        </span>
      )}
    </span>
  );
}

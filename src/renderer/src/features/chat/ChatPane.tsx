import { useQueryClient } from '@tanstack/react-query';
import { Loader2, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@renderer/components/ui/button';
import { Select } from '@renderer/components/ui/input';
import { invoke } from '@renderer/lib/ipc';
import {
  keys,
  useConversation,
  useConversationMutations,
  useMessagePath,
  useModels,
  useProfiles,
} from '@renderer/lib/queries';
import { cn } from '@renderer/lib/utils';
import { useStreamStore } from '@renderer/state/stream-store';
import { useUiStore } from '@renderer/state/ui-store';
import { Composer } from './Composer';
import { ConversationSettings } from './ConversationSettings';
import { MessageList } from './MessageList';

export function ChatPane({ conversationId }: { conversationId: string }) {
  const qc = useQueryClient();
  const conv = useConversation(conversationId);
  const path = useMessagePath(conversationId);
  const profiles = useProfiles();
  const models = useModels(conv.data?.serverProfileId ?? null);
  const { update } = useConversationMutations();
  const runningRunId = useStreamStore((s) => s.running[conversationId]);
  const begin = useStreamStore((s) => s.begin);
  const settingsOpen = useUiStore((s) => s.conversationSettingsOpen);
  const setSettingsOpen = useUiStore((s) => s.setConversationSettingsOpen);
  const [sendError, setSendError] = useState<string | null>(null);

  const c = conv.data;
  const canSend = !!c?.serverProfileId && !!c.model;

  const send = async (text: string) => {
    setSendError(null);
    try {
      const handle = await invoke('chat:send', { conversationId, text });
      begin(handle);
      await qc.invalidateQueries({ queryKey: keys.path(conversationId) });
      await qc.invalidateQueries({ queryKey: keys.conversations });
    } catch (e) {
      setSendError((e as Error).message);
    }
  };

  const regenerate = async (messageId: string) => {
    setSendError(null);
    try {
      const handle = await invoke('chat:regenerate', { messageId });
      begin(handle);
      await qc.invalidateQueries({ queryKey: keys.path(conversationId) });
    } catch (e) {
      setSendError((e as Error).message);
    }
  };

  const abort = () => {
    if (runningRunId) void invoke('chat:abort', { runId: runningRunId });
  };

  if (!c)
    return (
      <div className="text-fg-muted flex flex-1 items-center justify-center text-sm">
        読み込み中…
      </div>
    );

  return (
    <div className="flex min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-border flex items-center gap-2 border-b px-4 py-2">
          <Select
            className="w-44"
            value={c.serverProfileId ?? ''}
            onChange={(e) => {
              const id = e.target.value || null;
              const p = profiles.data?.find((x) => x.id === id);
              update.mutate({
                id: c.id,
                patch: { serverProfileId: id, model: p?.defaultModel ?? null },
              });
            }}
          >
            <option value="">サーバーを選択</option>
            {profiles.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          <Select
            className="w-64"
            value={c.model ?? ''}
            disabled={!c.serverProfileId}
            onChange={(e) => update.mutate({ id: c.id, patch: { model: e.target.value || null } })}
          >
            <option value="">
              {models.isPending && c.serverProfileId ? 'モデル取得中…' : 'モデルを選択'}
            </option>
            {c.model && !models.data?.some((m) => m.id === c.model) && (
              <option value={c.model}>{c.model}</option>
            )}
            {models.data?.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
          {models.isFetching && (
            <span className="text-fg-muted flex items-center gap-1 text-xs">
              <Loader2 size={14} className="animate-spin" /> モデル取得中
            </span>
          )}
          {models.isError && !models.isFetching && (
            <span className="flex min-w-0 items-center gap-1 text-xs text-red-400">
              <span className="truncate" title={String(models.error)}>
                モデル一覧を取得できません
              </span>
              <Button variant="ghost" size="sm" onClick={() => void models.refetch()}>
                <RefreshCw size={12} /> 再試行
              </Button>
            </span>
          )}
          <div className="flex-1" />
          <Button
            variant="ghost"
            size="icon"
            aria-label="会話の設定"
            className={cn(settingsOpen && 'bg-surface-3 text-fg')}
            onClick={() => setSettingsOpen(!settingsOpen)}
          >
            <SlidersHorizontal size={16} />
          </Button>
        </header>
        <MessageList
          conversationId={conversationId}
          messages={path.data ?? []}
          onRegenerate={(id) => void regenerate(id)}
        />
        {sendError && <div className="px-4 py-1 text-xs text-red-400">{sendError}</div>}
        <Composer
          disabled={!canSend}
          running={!!runningRunId}
          onSend={(t) => void send(t)}
          onAbort={abort}
        />
      </div>
      {settingsOpen && <ConversationSettings key={c.id} conversation={c} />}
    </div>
  );
}

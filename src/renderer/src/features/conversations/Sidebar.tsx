import { MessageSquarePlus, Pin, Settings, Trash2 } from 'lucide-react';
import { Button } from '@renderer/components/ui/button';
import { useConversationMutations, useConversations, useProfiles } from '@renderer/lib/queries';
import { cn, formatRelativeTime } from '@renderer/lib/utils';
import { useStreamStore } from '@renderer/state/stream-store';
import { useUiStore } from '@renderer/state/ui-store';

export function Sidebar() {
  const conversations = useConversations();
  const profiles = useProfiles();
  const { create, remove, update } = useConversationMutations();
  const selected = useUiStore((s) => s.selectedConversationId);
  const select = useUiStore((s) => s.select);
  const openProfiles = useUiStore((s) => s.setProfilesDialogOpen);
  const running = useStreamStore((s) => s.running);

  const newConversation = () => {
    const p = profiles.data?.[0] ?? null;
    create.mutate(
      { serverProfileId: p?.id ?? null, model: p?.defaultModel ?? null },
      { onSuccess: (c) => select(c.id) },
    );
  };

  const del = (id: string) => {
    if (!confirm('この会話を削除しますか?')) return;
    remove.mutate(id, { onSuccess: () => selected === id && select(null) });
  };

  return (
    <aside className="border-border bg-surface-2 flex w-64 shrink-0 flex-col border-r">
      <div className="flex items-center gap-1 px-2 py-2">
        <Button
          variant="secondary"
          className="flex-1 justify-start"
          onClick={newConversation}
          disabled={create.isPending}
        >
          <MessageSquarePlus size={15} /> 新しい会話
        </Button>
        <Button variant="ghost" size="icon" aria-label="設定" onClick={() => openProfiles(true)}>
          <Settings size={16} />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {conversations.data?.length === 0 && (
          <p className="text-fg-muted px-3 py-6 text-center text-xs">会話はまだありません</p>
        )}
        {conversations.data?.map((c) => (
          <div
            key={c.id}
            role="button"
            tabIndex={0}
            onClick={() => select(c.id)}
            onKeyDown={(e) => e.key === 'Enter' && select(c.id)}
            className={cn(
              'group hover:bg-surface-3 flex cursor-pointer items-center gap-1 rounded-md px-2 py-1.5 text-sm',
              selected === c.id && 'bg-surface-3',
            )}
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1 truncate">
                {c.pinned && <Pin size={11} className="text-fg-muted shrink-0" />}
                <span className="truncate">{c.title || '(無題)'}</span>
                {running[c.id] && (
                  <span className="bg-accent ml-1 inline-block h-1.5 w-1.5 shrink-0 animate-pulse rounded-full" />
                )}
              </div>
              <div className="text-fg-muted/70 text-[11px]">{formatRelativeTime(c.updatedAt)}</div>
            </div>
            <div className="flex shrink-0 opacity-0 group-hover:opacity-100">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={c.pinned ? 'ピン解除' : 'ピン留め'}
                onClick={(e) => {
                  e.stopPropagation();
                  update.mutate({ id: c.id, patch: { pinned: !c.pinned } });
                }}
              >
                <Pin size={12} />
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="削除"
                onClick={(e) => {
                  e.stopPropagation();
                  del(c.id);
                }}
              >
                <Trash2 size={12} />
              </Button>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}

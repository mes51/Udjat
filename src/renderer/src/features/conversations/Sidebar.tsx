import { useQueryClient } from '@tanstack/react-query';
import { MessageSquarePlus, Pin, Search, Settings, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { invoke } from '@renderer/lib/ipc';
import {
  invalidateConversationView,
  keys,
  useConversationMutations,
  useConversations,
  useProfiles,
  useSearch,
} from '@renderer/lib/queries';
import { cn, formatRelativeTime } from '@renderer/lib/utils';
import { useStreamStore } from '@renderer/state/stream-store';
import { useUiStore } from '@renderer/state/ui-store';

/** 全文検索の結果一覧。クリックで該当メッセージの分岐に切り替えて表示する */
function SearchResults({ query, onDone }: { query: string; onDone: () => void }) {
  const qc = useQueryClient();
  const results = useSearch(query);
  const select = useUiStore((s) => s.select);
  const setScrollTarget = useUiStore((s) => s.setScrollTarget);

  const open = async (conversationId: string, messageId: string) => {
    try {
      const conv = await invoke('messages:switchBranch', { conversationId, messageId });
      qc.setQueryData(keys.conversation(conversationId), conv);
      await invalidateConversationView(qc, conversationId);
    } catch {
      /* 会話が消えている等 */
    }
    select(conversationId);
    setScrollTarget({ conversationId, messageId });
    onDone();
  };

  if (results.isPending) return <p className="text-fg-muted px-3 py-4 text-xs">検索中…</p>;
  if (results.isError)
    return <p className="px-3 py-4 text-xs text-red-400">{String(results.error)}</p>;
  if (results.data.length === 0) return <p className="text-fg-muted px-3 py-4 text-xs">該当なし</p>;
  return (
    <div className="flex flex-col gap-0.5">
      {results.data.map((r) => (
        <button
          key={r.messageId}
          type="button"
          onClick={() => void open(r.conversationId, r.messageId)}
          className="hover:bg-surface-3 rounded-md px-2 py-1.5 text-left text-xs"
        >
          <div className="flex items-center gap-1">
            <span className="truncate font-medium">{r.conversationTitle || '(無題)'}</span>
            <span className="text-fg-muted/70 ml-auto shrink-0 text-[10px]">
              {r.role === 'user' ? 'ユーザー' : 'AI'} · {formatRelativeTime(r.createdAt)}
            </span>
          </div>
          <div className="text-fg-muted line-clamp-2">{r.snippet}</div>
        </button>
      ))}
    </div>
  );
}

export function Sidebar() {
  const conversations = useConversations();
  const profiles = useProfiles();
  const { create, remove, update } = useConversationMutations();
  const selected = useUiStore((s) => s.selectedConversationId);
  const select = useUiStore((s) => s.select);
  const openProfiles = useUiStore((s) => s.setProfilesDialogOpen);
  const running = useStreamStore((s) => s.running);
  const [query, setQuery] = useState('');

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
      <div className="relative px-2 pb-2">
        <Search size={13} className="text-fg-muted pointer-events-none absolute top-2.5 left-4" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="会話を検索"
          className="pl-7 pr-7"
          aria-label="検索"
        />
        {query && (
          <button
            type="button"
            aria-label="検索をクリア"
            className="text-fg-muted hover:text-fg absolute top-2.5 right-4"
            onClick={() => setQuery('')}
          >
            <X size={13} />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {query.trim() && <SearchResults query={query} onDone={() => setQuery('')} />}
        {!query.trim() && conversations.data?.length === 0 && (
          <p className="text-fg-muted px-3 py-6 text-center text-xs">会話はまだありません</p>
        )}
        {!query.trim() &&
          conversations.data?.map((c) => (
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
                <div className="text-fg-muted/70 text-[11px]">
                  {formatRelativeTime(c.updatedAt)}
                </div>
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

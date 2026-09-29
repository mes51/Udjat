import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Button } from '@renderer/components/ui/button';
import iconUrl from '@renderer/assets/udjat.svg';
import { Lightbox } from '@renderer/components/ui/lightbox';
import { subscribeChatEvents } from '@renderer/lib/chat-events';
import { invoke } from '@renderer/lib/ipc';
import {
  useConversationMutations,
  useConversations,
  useProfiles,
  useSetting,
} from '@renderer/lib/queries';
import { setTheme, type ThemeSetting } from '@renderer/lib/theme';
import { useStreamStore } from '@renderer/state/stream-store';
import { useUiStore } from '@renderer/state/ui-store';
import { ChatPane } from './features/chat/ChatPane';
import { Sidebar } from './features/conversations/Sidebar';
import { ProfilesDialog } from './features/settings/ProfilesDialog';

export function App() {
  const qc = useQueryClient();
  const selected = useUiStore((s) => s.selectedConversationId);
  const select = useUiStore((s) => s.select);
  const openProfiles = useUiStore((s) => s.setProfilesDialogOpen);
  const requestSearchFocus = useUiStore((s) => s.requestSearchFocus);
  const profiles = useProfiles();
  const conversations = useConversations();
  const { create } = useConversationMutations();
  const theme = useSetting<ThemeSetting>('ui.theme');

  useEffect(() => subscribeChatEvents(qc), [qc]);

  // DB に保存されたテーマ設定を反映(初回は localStorage の値で描画済み)
  useEffect(() => {
    if (theme.isFetched) setTheme(theme.data ?? 'system');
  }, [theme.isFetched, theme.data]);

  // 選択中の会話が消えていたら選択を解除
  useEffect(() => {
    if (!selected || !conversations.isSuccess || conversations.isFetching) return;
    if (!conversations.data.some((c) => c.id === selected)) select(null);
  }, [selected, conversations.data, conversations.isSuccess, conversations.isFetching, select]);

  // キーボードショートカット
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        const p = profiles.data?.[0] ?? null;
        create.mutate(
          { serverProfileId: p?.id ?? null, model: p?.defaultModel ?? null },
          { onSuccess: (c) => select(c.id) },
        );
      } else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        requestSearchFocus();
      } else if (mod && e.key === ',') {
        e.preventDefault();
        openProfiles(true);
      } else if (e.key === 'Escape' && !mod) {
        const cur = useUiStore.getState().selectedConversationId;
        const runId = cur ? useStreamStore.getState().running[cur] : undefined;
        if (runId) {
          e.preventDefault();
          void invoke('chat:abort', { runId });
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [profiles.data, create, select, requestSearchFocus, openProfiles]);

  return (
    <div className="flex h-full">
      <Sidebar />
      {selected ? (
        <ChatPane conversationId={selected} />
      ) : (
        <main className="text-fg-muted flex flex-1 flex-col items-center justify-center gap-3 text-sm">
          <div className="text-fg flex items-center gap-3 text-2xl font-semibold tracking-tight">
            <img src={iconUrl} alt="" aria-hidden className="h-12 w-12" draggable={false} />
            Udjat
          </div>
          {profiles.data?.length === 0 ? (
            <>
              <p>まずサーバープロファイルを登録してください。</p>
              <Button onClick={() => openProfiles(true)}>サーバーを登録</Button>
            </>
          ) : (
            <p>
              左の「新しい会話」から始めるか、既存の会話を選択してください。
              <span className="text-fg-muted/70 mt-2 block text-xs">
                Ctrl+N 新しい会話 · Ctrl+K 検索 · Ctrl+, 設定
              </span>
            </p>
          )}
        </main>
      )}
      <ProfilesDialog />
      <Lightbox />
    </div>
  );
}

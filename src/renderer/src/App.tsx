import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Button } from '@renderer/components/ui/button';
import { subscribeChatEvents } from '@renderer/lib/chat-events';
import { useConversations, useProfiles } from '@renderer/lib/queries';
import { useUiStore } from '@renderer/state/ui-store';
import { ChatPane } from './features/chat/ChatPane';
import { Sidebar } from './features/conversations/Sidebar';
import { ProfilesDialog } from './features/settings/ProfilesDialog';

export function App() {
  const qc = useQueryClient();
  const selected = useUiStore((s) => s.selectedConversationId);
  const select = useUiStore((s) => s.select);
  const openProfiles = useUiStore((s) => s.setProfilesDialogOpen);
  const profiles = useProfiles();
  const conversations = useConversations();

  useEffect(() => subscribeChatEvents(qc), [qc]);

  // 選択中の会話が消えていたら選択を解除
  useEffect(() => {
    if (!selected || !conversations.isSuccess || conversations.isFetching) return;
    if (!conversations.data.some((c) => c.id === selected)) select(null);
  }, [selected, conversations.data, conversations.isSuccess, conversations.isFetching, select]);

  return (
    <div className="flex h-full">
      <Sidebar />
      {selected ? (
        <ChatPane conversationId={selected} />
      ) : (
        <main className="text-fg-muted flex flex-1 flex-col items-center justify-center gap-3 text-sm">
          <div className="text-fg text-xl font-semibold">Udjat</div>
          {profiles.data?.length === 0 ? (
            <>
              <p>まずサーバープロファイルを登録してください。</p>
              <Button onClick={() => openProfiles(true)}>サーバーを登録</Button>
            </>
          ) : (
            <p>左の「新しい会話」から始めるか、既存の会話を選択してください。</p>
          )}
        </main>
      )}
      <ProfilesDialog />
    </div>
  );
}

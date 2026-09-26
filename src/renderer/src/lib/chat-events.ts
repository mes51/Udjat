import type { QueryClient } from '@tanstack/react-query';
import { useStreamStore } from '@renderer/state/stream-store';
import { onEvent } from './ipc';
import { keys } from './queries';

/**
 * main からの chat:event を購読して stream-store に流し込む。
 * done を受けたら DB を正として再取得し、少し待ってから一時状態を捨てる。
 */
export function subscribeChatEvents(qc: QueryClient): () => void {
  return onEvent('chat:event', (ev) => {
    useStreamStore.getState().apply(ev);
    if (ev.event.type === 'done') {
      void qc.invalidateQueries({ queryKey: keys.path(ev.conversationId) }).then(() => {
        // 再取得後に一時状態を消す(消すのが早いと一瞬空になる)
        setTimeout(() => useStreamStore.getState().clear(ev.messageId), 50);
      });
      void qc.invalidateQueries({ queryKey: keys.conversations });
    }
  });
}

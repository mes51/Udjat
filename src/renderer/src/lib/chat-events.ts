import type { QueryClient } from '@tanstack/react-query';
import { useStreamStore } from '@renderer/state/stream-store';
import { onEvent } from './ipc';
import { invalidateConversationView, keys } from './queries';

/**
 * main からの chat:event を購読して stream-store に流し込む。
 * - done: そのセグメントの assistant が確定したので path を再取得し、少し待って一時状態を捨てる
 * - path-changed: tool メッセージや次の assistant が追加されたので path を再取得
 * - run-end: 会話一覧(更新時刻)を更新
 */
export function subscribeChatEvents(qc: QueryClient): () => void {
  return onEvent('chat:event', (ev) => {
    useStreamStore.getState().apply(ev);
    const t = ev.event.type;
    if (t === 'done' || t === 'path-changed') {
      void invalidateConversationView(qc, ev.conversationId).then(() => {
        if (t === 'done') setTimeout(() => useStreamStore.getState().clear(ev.messageId), 50);
      });
    }
    if (t === 'run-end') {
      void invalidateConversationView(qc, ev.conversationId);
      // タイトル自動生成は run-end の後に走るので、少し遅らせてもう一度一覧を取り直す
      void qc.invalidateQueries({ queryKey: keys.conversations });
      setTimeout(() => void qc.invalidateQueries({ queryKey: keys.conversations }), 4000);
      setTimeout(() => void qc.invalidateQueries({ queryKey: keys.conversations }), 15000);
    }
  });
}

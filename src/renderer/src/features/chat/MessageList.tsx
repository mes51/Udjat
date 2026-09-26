import { useEffect, useRef } from 'react';
import type { Message } from '@shared/schemas';
import { useStreamStore } from '@renderer/state/stream-store';
import { useUiStore } from '@renderer/state/ui-store';
import { MessageItem, type BranchInfo } from './MessageItem';

export function MessageList({
  conversationId,
  messages,
  branches,
  onRegenerate,
  onSwitchBranch,
  onEdit,
}: {
  conversationId: string;
  messages: Message[];
  branches: Record<string, BranchInfo>;
  onRegenerate: (messageId: string) => void;
  onSwitchBranch: (messageId: string) => void;
  onEdit: (messageId: string, text: string) => void;
}) {
  const streams = useStreamStore((s) => s.streams);
  const running = useStreamStore((s) => !!s.running[conversationId]);
  const scrollTarget = useUiStore((s) => s.scrollTarget);
  const setScrollTarget = useUiStore((s) => s.setScrollTarget);
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  // ユーザーが上にスクロールしていたら自動追従しない
  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };

  const streamingText = Object.values(streams)
    .map((s) => s.text.length + s.reasoning.length)
    .reduce((a, b) => a + b, 0);
  useEffect(() => {
    if (stickToBottom.current) bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, streamingText]);

  // 検索結果などから指定されたメッセージへスクロールし、しばらく強調する
  const highlightedId =
    scrollTarget?.conversationId === conversationId ? scrollTarget.messageId : null;
  useEffect(() => {
    if (!highlightedId) return;
    const el = document.getElementById(`msg-${highlightedId}`);
    if (!el) return;
    stickToBottom.current = false;
    el.scrollIntoView({ block: 'center' });
    const t = setTimeout(() => setScrollTarget(null), 2500);
    return () => clearTimeout(t);
  }, [highlightedId, messages, setScrollTarget]);

  const lastAssistantId = [...messages]
    .reverse()
    .find((m) => m.role === 'assistant' && m.kind === 'normal')?.id;

  return (
    <div ref={containerRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl py-2">
        {messages.length === 0 && (
          <div className="text-fg-muted px-4 py-16 text-center text-sm">
            メッセージを送って会話を始めましょう。
          </div>
        )}
        {messages.map((m) => (
          <MessageItem
            key={m.id}
            message={m}
            stream={streams[m.id]}
            isLastAssistant={m.id === lastAssistantId}
            branch={branches[m.id]}
            highlighted={m.id === highlightedId}
            // run 全体(ツールループ含む)が終わるまで再生成・編集・分岐切替は出さない
            {...(running ? {} : { onRegenerate, onSwitchBranch, onEdit })}
          />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

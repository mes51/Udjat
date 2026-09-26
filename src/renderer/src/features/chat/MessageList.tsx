import { useEffect, useRef } from 'react';
import type { Message } from '@shared/schemas';
import { useStreamStore } from '@renderer/state/stream-store';
import { MessageItem } from './MessageItem';

export function MessageList({
  messages,
  onRegenerate,
}: {
  messages: Message[];
  onRegenerate: (messageId: string) => void;
}) {
  const streams = useStreamStore((s) => s.streams);
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

  const visible = messages.filter((m) => m.kind !== 'tool-media');
  const lastAssistantId = [...visible]
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
        {visible.map((m) => (
          <MessageItem
            key={m.id}
            message={m}
            stream={streams[m.id]}
            isLastAssistant={m.id === lastAssistantId}
            onRegenerate={onRegenerate}
          />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

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
  onBranchFrom,
}: {
  conversationId: string;
  messages: Message[];
  branches: Record<string, BranchInfo>;
  onRegenerate: (messageId: string) => void;
  onSwitchBranch: (messageId: string) => void;
  onEdit: (messageId: string, text: string) => void;
  onBranchFrom: (messageId: string) => void;
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

  // 分岐ナビの表示位置。assistant の分岐(再生成)は、ツール呼び出しを含む応答でも
  // 応答グループの末尾(最後の assistant セグメント)に出す。user の分岐(編集)はその発言に出す。
  const navFor: Record<string, BranchInfo> = {};
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    const b = branches[m.id];
    if (!b) continue;
    if (m.role === 'user' && m.kind === 'normal') {
      navFor[m.id] = b;
      continue;
    }
    if (m.role !== 'assistant') continue;
    let target = m.id;
    for (let j = i + 1; j < messages.length; j++) {
      const n = messages[j]!;
      if (n.role === 'user' && n.kind === 'normal') break;
      if (n.role === 'assistant' && n.kind === 'normal') target = n.id;
    }
    navFor[target] = b;
  }

  // 「ここから分岐」を出す assistant: 応答グループの末尾で、後ろにユーザー発言が続いているもの
  // (末尾の応答は普通に入力すれば続きになるので不要)
  const branchable = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== 'assistant' || m.kind !== 'normal') continue;
    const next = messages[i + 1];
    // 直後が要約ノードの応答も対象(圧縮前の履歴で続けたい時の入口)
    if (next && next.role === 'user' && (next.kind === 'normal' || next.kind === 'compaction'))
      branchable.add(m.id);
  }

  // 最後の要約ノードより前はモデルに送られないので薄く表示する(M14)
  let lastCompaction = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.kind === 'compaction') {
      lastCompaction = i;
      break;
    }
  }

  return (
    <div ref={containerRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl py-2">
        {messages.length === 0 && (
          <div className="text-fg-muted px-4 py-16 text-center text-sm">
            メッセージを送って会話を始めましょう。
          </div>
        )}
        {messages.map((m, i) => (
          <MessageItem
            key={m.id}
            message={m}
            dimmed={i < lastCompaction}
            stream={streams[m.id]}
            isLastAssistant={m.id === lastAssistantId}
            branch={navFor[m.id]}
            highlighted={m.id === highlightedId}
            // run 全体(ツールループ含む)が終わるまで再生成・編集・分岐切替は出さない
            {...(running ? {} : { onSwitchBranch, onEdit })}
            // 再生成は応答グループの末尾(最後の応答、または後ろにユーザー発言が続く応答)に出す(M20)
            {...(!running && (m.id === lastAssistantId || branchable.has(m.id))
              ? { onRegenerate }
              : {})}
            {...(!running && branchable.has(m.id) ? { onBranchFrom } : {})}
          />
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

import { Collapsible } from 'radix-ui';
import {
  AlertCircle,
  Bot,
  Brain,
  ChevronLeft,
  ChevronRight,
  Images,
  Info,
  Pencil,
  RefreshCw,
  Send,
  User,
} from 'lucide-react';
import { mediaUrl } from '@renderer/lib/attachments';
import { PartMedia } from './AttachmentChips';
import { useRef, useState } from 'react';
import type { Message, Part, Usage } from '@shared/schemas';
import { Button } from '@renderer/components/ui/button';
import { cn, formatDuration } from '@renderer/lib/utils';
import { useStreamStore, type StreamState } from '@renderer/state/stream-store';
import { Markdown } from './Markdown';
import { ApprovalCard, ToolCallList, ToolResultCard } from './ToolBlocks';

export interface BranchInfo {
  index: number;
  count: number;
  ids: string[];
}

export interface MessageItemProps {
  message: Message;
  stream?: StreamState | undefined;
  isLastAssistant: boolean;
  branch?: BranchInfo | undefined;
  highlighted?: boolean;
  onRegenerate?: (messageId: string) => void;
  onSwitchBranch?: (messageId: string) => void;
  /** ユーザー発言の編集(新しい分岐として送り直す)。undefined なら編集不可(生成中など) */
  onEdit?: (messageId: string, text: string) => void;
}

/** 兄弟分岐の切り替え `< 2/3 >` */
function BranchNav({
  branch,
  onSwitch,
}: {
  branch: BranchInfo;
  onSwitch?: ((id: string) => void) | undefined;
}) {
  const prev = branch.ids[branch.index - 1];
  const next = branch.ids[branch.index + 1];
  return (
    <span className="text-fg-muted inline-flex items-center gap-0.5 text-[11px]">
      <button
        type="button"
        className="hover:text-fg disabled:opacity-30"
        disabled={!prev || !onSwitch}
        onClick={() => prev && onSwitch?.(prev)}
        aria-label="前の分岐"
      >
        <ChevronLeft size={13} />
      </button>
      <span className="tabular-nums">
        {branch.index + 1}/{branch.count}
      </span>
      <button
        type="button"
        className="hover:text-fg disabled:opacity-30"
        disabled={!next || !onSwitch}
        onClick={() => next && onSwitch?.(next)}
        aria-label="次の分岐"
      >
        <ChevronRight size={13} />
      </button>
    </span>
  );
}

/** ユーザー発言の編集フォーム */
function EditForm({
  initial,
  onSubmit,
  onCancel,
}: {
  initial: string;
  onSubmit: (t: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initial);
  const composing = useRef(false);
  return (
    <div className="flex flex-col gap-2">
      <textarea
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onCompositionStart={() => (composing.current = true)}
        onCompositionEnd={() => (composing.current = false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
          if (
            e.key === 'Enter' &&
            !e.shiftKey &&
            !composing.current &&
            !e.nativeEvent.isComposing
          ) {
            e.preventDefault();
            if (text.trim()) onSubmit(text.trim());
          }
        }}
        className="border-border bg-surface focus-visible:ring-accent/60 min-h-20 w-full resize-y rounded-md border px-2.5 py-1.5 text-[15px] leading-relaxed focus-visible:ring-2 focus-visible:outline-none"
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={() => text.trim() && onSubmit(text.trim())}
          disabled={!text.trim()}
        >
          <Send size={12} /> 送信して分岐
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          キャンセル
        </Button>
        <span className="text-fg-muted self-center text-[11px]">添付は引き継がれます</span>
      </div>
    </div>
  );
}

function pickText(
  message: Message,
  stream: StreamState | undefined,
): { text: string; reasoning: string } {
  if (stream) return { text: stream.text, reasoning: stream.reasoning };
  const text = message.parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
  const reasoning = message.parts
    .filter((p) => p.type === 'reasoning')
    .map((p) => p.text)
    .join('\n');
  return { text, reasoning };
}

function ReasoningBlock({ text, streaming }: { text: string; streaming: boolean }) {
  // ストリーミング中は開き、完了したら折りたたむ(ユーザーが触ったら尊重する)
  const [open, setOpen] = useState(streaming);
  const [touched, setTouched] = useState(false);
  const [prevStreaming, setPrevStreaming] = useState(streaming);
  if (prevStreaming !== streaming) {
    setPrevStreaming(streaming);
    if (!touched) setOpen(streaming);
  }

  return (
    <Collapsible.Root
      open={open}
      onOpenChange={(o) => {
        setTouched(true);
        setOpen(o);
      }}
      className="border-border bg-surface/60 mb-2 rounded-md border"
    >
      <Collapsible.Trigger className="text-fg-muted hover:text-fg flex w-full items-center gap-1.5 px-2.5 py-1.5 text-xs">
        <ChevronRight size={14} className={cn('transition-transform', open && 'rotate-90')} />
        <Brain size={13} />
        <span>{streaming ? '思考中…' : '思考過程'}</span>
        <span className="ml-auto opacity-60">{[...text].length} 文字</span>
      </Collapsible.Trigger>
      <Collapsible.Content>
        <div className="text-fg-muted border-border max-h-72 overflow-auto border-t px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap">
          {text}
        </div>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

/** ユーザーメッセージの添付(画像・動画・音声・ファイル) */
function MediaParts({ message }: { message: Message }) {
  const media = message.parts.filter(
    (p): p is Exclude<Part, { type: 'text' } | { type: 'reasoning' }> =>
      p.type !== 'text' && p.type !== 'reasoning',
  );
  if (media.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {media.map((p, i) => (
        <PartMedia
          key={`${p.attachmentId}-${i}`}
          type={p.type}
          attachmentId={p.attachmentId}
          name={p.name}
        />
      ))}
    </div>
  );
}

/** ツールが返した画像・動画(モデルに送られたもの)のサムネイル列 */
function ToolMediaStrip({ message }: { message: Message }) {
  const media = message.parts.filter((p) => p.type === 'image' || p.type === 'video');
  return (
    <div className="px-4 py-1 pl-14">
      <div className="text-fg-muted mb-1 flex items-center gap-1 text-[11px]">
        <Images size={12} /> モデルに渡した画像 ({media.length})
      </div>
      <div className="flex flex-wrap gap-1.5">
        {media.map((p, i) =>
          p.type === 'image' ? (
            <a
              key={`${p.attachmentId}-${i}`}
              href={mediaUrl(p.attachmentId)}
              target="_blank"
              rel="noreferrer"
              title={p.name}
            >
              <img
                src={mediaUrl(p.attachmentId)}
                alt={p.name ?? ''}
                className="border-border h-24 rounded border object-cover"
                loading="lazy"
              />
            </a>
          ) : p.type === 'video' ? (
            <PartMedia
              key={`${p.attachmentId}-${i}`}
              type="video"
              attachmentId={p.attachmentId}
              name={p.name}
            />
          ) : null,
        )}
      </div>
    </div>
  );
}

function UsageLine({ usage, model }: { usage: Usage | null; model: string | null }) {
  if (!usage && !model) return null;
  const parts: string[] = [];
  if (model) parts.push(model);
  if (usage?.promptTokens !== undefined) parts.push(`in ${usage.promptTokens}`);
  if (usage?.completionTokens !== undefined) parts.push(`out ${usage.completionTokens}`);
  if (usage?.completionTokens !== undefined && usage.durationMs && usage.durationMs > 0) {
    parts.push(`${((usage.completionTokens / usage.durationMs) * 1000).toFixed(1)} tok/s`);
  } else if (usage?.durationMs) {
    parts.push(formatDuration(usage.durationMs));
  }
  return <div className="text-fg-muted/70 mt-1 text-[11px]">{parts.join(' · ')}</div>;
}

export function MessageItem({
  message,
  stream,
  isLastAssistant,
  branch,
  highlighted,
  onRegenerate,
  onSwitchBranch,
  onEdit,
}: MessageItemProps) {
  const approvals = useStreamStore((s) => s.approvals);
  const [editing, setEditing] = useState(false);
  if (message.role === 'tool') return <ToolResultCard message={message} />;
  if (message.kind === 'tool-media') return <ToolMediaStrip message={message} />;
  if (message.kind === 'note') {
    return (
      <div className="text-fg-muted flex items-center gap-1.5 px-4 py-1 pl-14 text-xs">
        <Info size={13} />
        {message.parts
          .filter((p) => p.type === 'text')
          .map((p) => p.text)
          .join('\n')}
      </div>
    );
  }

  const isUser = message.role === 'user';
  const streaming = stream?.status === 'streaming';
  const { text, reasoning } = pickText(message, stream);
  const error = stream?.error ?? message.error;
  const finish = stream?.finishReason ?? message.finishReason;
  const toolCalls = message.toolCalls ?? [];
  const pendingForThis = Object.values(approvals).filter((a) => a.messageId === message.id);

  return (
    <div
      id={`msg-${message.id}`}
      className={cn(
        'group flex gap-3 px-4 py-3 transition-colors',
        isUser && 'bg-surface-2/40',
        highlighted && 'bg-accent/10',
      )}
    >
      <div
        className={cn(
          'mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md',
          isUser ? 'bg-accent/20 text-accent' : 'bg-surface-3 text-fg-muted',
        )}
      >
        {isUser ? <User size={15} /> : <Bot size={15} />}
      </div>
      <div className="min-w-0 flex-1">
        {reasoning && <ReasoningBlock text={reasoning} streaming={streaming && !text} />}
        {isUser ? (
          editing ? (
            <EditForm
              initial={text}
              onSubmit={(t) => {
                setEditing(false);
                onEdit?.(message.id, t);
              }}
              onCancel={() => setEditing(false)}
            />
          ) : (
            <>
              {text && (
                <div className="text-[15px] leading-relaxed whitespace-pre-wrap">{text}</div>
              )}
              <MediaParts message={message} />
              <div className="mt-1 flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100">
                {onEdit && (
                  <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
                    <Pencil size={12} /> 編集
                  </Button>
                )}
                {branch && <BranchNav branch={branch} onSwitch={onSwitchBranch} />}
              </div>
            </>
          )
        ) : text ? (
          <Markdown text={text} />
        ) : streaming ? (
          <div className="text-fg-muted text-sm">応答を待っています…</div>
        ) : null}
        {streaming && text && (
          <span className="bg-fg ml-0.5 inline-block h-4 w-1.5 animate-pulse align-text-bottom" />
        )}
        {toolCalls.length > 0 && <ToolCallList calls={toolCalls} messageId={message.id} />}
        {pendingForThis.map((a) => (
          <ApprovalCard key={a.call.id} callId={a.call.id} />
        ))}
        {error && (
          <div className="mt-2 flex items-start gap-1.5 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1.5 text-xs text-red-300">
            <AlertCircle size={14} className="mt-0.5 shrink-0" />
            <span className="break-all">{error}</span>
          </div>
        )}
        {finish === 'aborted' && (
          <div className="text-fg-muted mt-1 text-[11px]">中断されました</div>
        )}
        {finish === 'length' && (
          <div className="text-fg-muted mt-1 text-[11px]">最大トークン数に達しました</div>
        )}
        {!isUser && !streaming && finish !== 'tool_calls' && (
          <UsageLine usage={stream?.usage ?? message.usage} model={message.model} />
        )}
        {!isUser && !streaming && (isLastAssistant || branch) && (
          <div className="mt-1 flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100">
            {isLastAssistant && onRegenerate && (
              <Button variant="ghost" size="sm" onClick={() => onRegenerate(message.id)}>
                <RefreshCw size={12} /> 再生成
              </Button>
            )}
            {branch && <BranchNav branch={branch} onSwitch={onSwitchBranch} />}
          </div>
        )}
      </div>
    </div>
  );
}

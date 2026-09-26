import { Collapsible } from 'radix-ui';
import { AlertCircle, Bot, Brain, ChevronRight, Info, RefreshCw, User } from 'lucide-react';
import { useState } from 'react';
import type { Message, Usage } from '@shared/schemas';
import { Button } from '@renderer/components/ui/button';
import { cn, formatDuration } from '@renderer/lib/utils';
import { useStreamStore, type StreamState } from '@renderer/state/stream-store';
import { Markdown } from './Markdown';
import { ApprovalCard, ToolCallList, ToolResultCard } from './ToolBlocks';

export interface MessageItemProps {
  message: Message;
  stream?: StreamState | undefined;
  isLastAssistant: boolean;
  onRegenerate?: (messageId: string) => void;
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

export function MessageItem({ message, stream, isLastAssistant, onRegenerate }: MessageItemProps) {
  const approvals = useStreamStore((s) => s.approvals);
  if (message.role === 'tool') return <ToolResultCard message={message} />;
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
    <div className={cn('group flex gap-3 px-4 py-3', isUser && 'bg-surface-2/40')}>
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
          <div className="text-[15px] leading-relaxed whitespace-pre-wrap">{text}</div>
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
        {!isUser && !streaming && isLastAssistant && onRegenerate && (
          <div className="mt-1 opacity-0 transition-opacity group-hover:opacity-100">
            <Button variant="ghost" size="sm" onClick={() => onRegenerate(message.id)}>
              <RefreshCw size={12} /> 再生成
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

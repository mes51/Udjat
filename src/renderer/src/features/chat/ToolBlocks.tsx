import { Collapsible } from 'radix-ui';
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Loader2,
  ShieldQuestion,
  Wrench,
  X,
} from 'lucide-react';
import { useState } from 'react';
import type { Message, ToolApprovalDecision, ToolCall, ToolMeta } from '@shared/schemas';
import { Button } from '@renderer/components/ui/button';
import { invoke } from '@renderer/lib/ipc';
import { cn, formatDuration } from '@renderer/lib/utils';
import { useStreamStore, type ToolActivity } from '@renderer/state/stream-store';

function prettyArgs(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
}

function prettyResult(text: string): string {
  const t = text.trim();
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return JSON.stringify(JSON.parse(t), null, 2);
    } catch {
      /* not json */
    }
  }
  return text;
}

/** assistant メッセージのツール呼び出し一覧(実行状況つき) */
export function ToolCallList({ calls, messageId }: { calls: ToolCall[]; messageId: string }) {
  const activity = useStreamStore((s) => s.toolActivity[messageId]);
  return (
    <div className="mt-2 flex flex-col gap-1">
      {calls.map((c) => (
        <ToolCallRow key={c.id} call={c} activity={activity?.[c.id]} />
      ))}
    </div>
  );
}

function ToolCallRow({ call, activity }: { call: ToolCall; activity: ToolActivity | undefined }) {
  const [open, setOpen] = useState(false);
  const running = activity?.status === 'running';
  return (
    <Collapsible.Root
      open={open}
      onOpenChange={setOpen}
      className="border-border bg-surface/60 rounded-md border"
    >
      <Collapsible.Trigger className="text-fg-muted hover:text-fg flex w-full items-center gap-1.5 px-2.5 py-1.5 text-xs">
        <ChevronRight size={14} className={cn('transition-transform', open && 'rotate-90')} />
        {running ? <Loader2 size={13} className="animate-spin" /> : <Wrench size={13} />}
        <span className="font-mono">{call.name}</span>
        {running && <span className="ml-1">実行中…</span>}
        {activity?.status === 'done' && (
          <span className={cn('ml-1', activity.isError && 'text-red-400')}>
            {activity.isError ? 'エラー' : '完了'}
            {activity.durationMs !== null && ` · ${formatDuration(activity.durationMs)}`}
          </span>
        )}
      </Collapsible.Trigger>
      <Collapsible.Content>
        <pre className="text-fg-muted border-border max-h-60 overflow-auto border-t px-3 py-2 text-[11px] leading-relaxed">
          {prettyArgs(call.args)}
        </pre>
      </Collapsible.Content>
    </Collapsible.Root>
  );
}

/** role: tool のメッセージ(結果カード) */
export function ToolResultCard({ message }: { message: Message }) {
  const [open, setOpen] = useState(false);
  const meta = (message.toolMeta ?? null) as ToolMeta | null;
  const text = message.parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
  const isError = meta?.isError ?? text.startsWith('error:');
  return (
    <div className="px-4 py-1 pl-14">
      <Collapsible.Root
        open={open}
        onOpenChange={setOpen}
        className={cn(
          'border-border bg-surface/60 rounded-md border',
          isError && 'border-red-500/30',
        )}
      >
        <Collapsible.Trigger className="text-fg-muted hover:text-fg flex w-full items-center gap-1.5 px-2.5 py-1.5 text-xs">
          <ChevronRight size={14} className={cn('transition-transform', open && 'rotate-90')} />
          {isError ? (
            <AlertTriangle size={13} className="text-red-400" />
          ) : (
            <Check size={13} className="text-emerald-400" />
          )}
          <span className="font-mono">{meta?.name ?? 'tool'}</span>
          <span className="ml-1 opacity-70">
            {meta?.approval === 'denied' ? '拒否' : isError ? 'エラー' : '結果'}
            {meta ? ` · ${formatDuration(meta.durationMs)}` : ''}
            {` · ${[...text].length} 文字`}
          </span>
        </Collapsible.Trigger>
        <Collapsible.Content>
          <pre className="text-fg-muted border-border max-h-80 overflow-auto border-t px-3 py-2 text-[11px] leading-relaxed whitespace-pre-wrap">
            {prettyResult(text)}
          </pre>
        </Collapsible.Content>
      </Collapsible.Root>
    </div>
  );
}

/** 承認待ちカード */
export function ApprovalCard({ callId }: { callId: string }) {
  const approval = useStreamStore((s) => s.approvals[callId]);
  const resolve = useStreamStore((s) => s.resolveApproval);
  const [busy, setBusy] = useState(false);
  if (!approval) return null;

  const decide = async (decision: ToolApprovalDecision) => {
    setBusy(true);
    try {
      await invoke('tools:approve', { runId: approval.runId, callId, decision });
    } finally {
      resolve(callId);
      setBusy(false);
    }
  };

  return (
    <div className="border-accent/40 bg-accent/10 mt-2 rounded-md border px-3 py-2 text-sm">
      <div className="flex items-center gap-1.5">
        <ShieldQuestion size={15} className="text-accent" />
        <span>
          ツール <span className="font-mono">{approval.call.name}</span> の実行を許可しますか?
        </span>
      </div>
      <pre className="text-fg-muted my-2 max-h-40 overflow-auto text-[11px] leading-relaxed">
        {prettyArgs(approval.call.args)}
      </pre>
      <div className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => void decide('allow')}>
          <Check size={13} /> 許可
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => void decide('allow-conversation')}
        >
          この会話では常に許可
        </Button>
        <Button size="sm" variant="danger" disabled={busy} onClick={() => void decide('deny')}>
          <X size={13} /> 拒否
        </Button>
      </div>
    </div>
  );
}

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
import { useAbortTaskMutation } from '@renderer/lib/queries';
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
      className="border-border bg-surface-2 rounded-md border"
    >
      <Collapsible.Trigger className="text-fg-muted hover:text-fg flex w-full items-center gap-1.5 px-2.5 py-1.5 text-xs">
        <ChevronRight size={14} className={cn('transition-transform', open && 'rotate-90')} />
        {running ? <Loader2 size={13} className="animate-spin" /> : <Wrench size={13} />}
        <span className="font-mono">{call.name}</span>
        {running && <span className="ml-1">実行中…</span>}
        {activity?.status === 'done' && (
          <span className={cn('ml-1', activity.isError && 'text-danger')}>
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
  const bg = meta?.background;
  const bgRunning = bg?.status === 'running';
  const abortTask = useAbortTaskMutation();
  return (
    <div className="px-4 py-1 pl-14">
      <Collapsible.Root
        open={open}
        onOpenChange={setOpen}
        className={cn(
          'border-border bg-surface-2 rounded-md border',
          isError && 'border-danger/30',
          bgRunning && 'border-accent/40',
        )}
      >
        <Collapsible.Trigger className="text-fg-muted hover:text-fg flex w-full items-center gap-1.5 px-2.5 py-1.5 text-xs">
          <ChevronRight size={14} className={cn('transition-transform', open && 'rotate-90')} />
          {bgRunning ? (
            <Loader2 size={13} className="text-accent animate-spin" />
          ) : isError ? (
            <AlertTriangle size={13} className="text-danger" />
          ) : (
            <Check size={13} className="text-success" />
          )}
          <span className="font-mono">{meta?.name ?? 'tool'}</span>
          <span className="ml-1 opacity-70">
            {bgRunning
              ? 'バックグラウンドで実行中'
              : meta?.approval === 'denied'
                ? '拒否'
                : isError
                  ? 'エラー'
                  : '結果'}
            {bg && !bgRunning
              ? ` · バックグラウンド${bg.status === 'aborted' ? '(中断)' : bg.status === 'lost' ? '(消失)' : ''}`
              : ''}
            {meta && !bgRunning ? ` · ${formatDuration(meta.durationMs)}` : ''}
            {!bgRunning && ` · ${[...text].length} 文字`}
          </span>
          {bgRunning && (
            <Button
              variant="ghost"
              size="sm"
              className="ml-auto"
              disabled={abortTask.isPending}
              onClick={(e) => {
                e.stopPropagation();
                if (message.toolCallId)
                  abortTask.mutate({
                    conversationId: message.conversationId,
                    callId: message.toolCallId,
                  });
              }}
            >
              <X size={12} /> 中断
            </Button>
          )}
          {meta?.denyReason && (
            <span className="text-warning ml-1 min-w-0 truncate" title={meta.denyReason}>
              理由: {meta.denyReason}
            </span>
          )}
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

/** run_javascript の引数(承認カードでコードと権限を分けて見せる) */
function parseCodeArgs(args: string): {
  code: string;
  perms: { label: string; items: string[] }[];
} | null {
  try {
    const a = JSON.parse(args) as Record<string, unknown>;
    if (typeof a['code'] !== 'string') return null;
    const list = (k: string) =>
      Array.isArray(a[k]) ? (a[k] as unknown[]).filter((x) => typeof x === 'string') : [];
    return {
      code: a['code'],
      perms: [
        { label: '読み取り', items: list('allow_read') as string[] },
        { label: '書き込み', items: list('allow_write') as string[] },
        { label: 'ネットワーク', items: list('allow_net') as string[] },
        {
          label: 'ダウンロード',
          items:
            typeof a['allow_download'] === 'number' && a['allow_download'] > 0
              ? [
                  `最大 ${(a['allow_download'] / (1024 * 1024)).toFixed(a['allow_download'] % (1024 * 1024) === 0 ? 0 : 1)} MB`,
                ]
              : [],
        },
      ].filter((p) => p.items.length > 0),
    };
  } catch {
    return null;
  }
}

/** fs_write の引数(承認カードでパス・モードと内容を分けて見せる) */
function parseWriteArgs(args: string): { path: string; mode: string; content: string } | null {
  try {
    const a = JSON.parse(args) as Record<string, unknown>;
    if (typeof a['path'] !== 'string') return null;
    const mode = a['mode'] === 'append' ? '追記' : a['mode'] === 'create' ? '新規作成' : '上書き';
    const content =
      a['encoding'] === 'base64'
        ? `(base64 ${typeof a['content'] === 'string' ? a['content'].length : 0} 文字)`
        : typeof a['content'] === 'string'
          ? a['content']
          : '';
    return { path: a['path'], mode, content };
  } catch {
    return null;
  }
}

/** 承認待ちカード */
export function ApprovalCard({ callId }: { callId: string }) {
  const approval = useStreamStore((s) => s.approvals[callId]);
  const resolve = useStreamStore((s) => s.resolveApproval);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  if (!approval) return null;

  const decide = async (decision: ToolApprovalDecision) => {
    setBusy(true);
    try {
      await invoke('tools:approve', {
        runId: approval.runId,
        callId,
        decision,
        ...(decision === 'deny' && reason.trim() ? { reason: reason.trim() } : {}),
      });
    } finally {
      resolve(callId);
      setBusy(false);
    }
  };
  const code = approval.call.name === 'run_javascript' ? parseCodeArgs(approval.call.args) : null;
  const write = approval.call.name === 'fs_write' ? parseWriteArgs(approval.call.args) : null;

  return (
    <div className="border-accent/40 bg-accent/10 mt-2 rounded-md border px-3 py-2 text-sm">
      <div className="flex items-center gap-1.5">
        <ShieldQuestion size={15} className="text-accent" />
        <span>
          {code ? (
            code.perms.length > 0 ? (
              'コードの実行と、次の権限を許可しますか?'
            ) : (
              'コードの実行を許可しますか?(ファイル・ネットワークへのアクセスはありません)'
            )
          ) : write ? (
            'ファイルへの書き込みを許可しますか?'
          ) : (
            <>
              ツール <span className="font-mono">{approval.call.name}</span> の実行を許可しますか?
            </>
          )}
        </span>
      </div>
      {write ? (
        <>
          <ul className="my-2 flex flex-col gap-0.5 text-xs">
            <li className="flex gap-2">
              <span className="w-20 shrink-0 text-warning">{write.mode}</span>
              <span className="font-mono break-all">{write.path}</span>
            </li>
          </ul>
          <pre className="text-fg border-border bg-surface my-2 max-h-64 overflow-auto rounded border px-2 py-1.5 text-[11px] leading-relaxed whitespace-pre-wrap">
            {write.content}
          </pre>
        </>
      ) : code ? (
        <>
          {code.perms.length > 0 && (
            <ul className="my-2 flex flex-col gap-0.5 text-xs">
              {code.perms.map((p) => (
                <li key={p.label} className="flex gap-2">
                  <span className="w-20 shrink-0 text-warning">{p.label}</span>
                  <span className="font-mono break-all">{p.items.join(', ')}</span>
                </li>
              ))}
            </ul>
          )}
          <pre className="text-fg border-border bg-surface my-2 max-h-64 overflow-auto rounded border px-2 py-1.5 text-[11px] leading-relaxed">
            {code.code}
          </pre>
        </>
      ) : (
        <pre className="text-fg-muted my-2 max-h-40 overflow-auto text-[11px] leading-relaxed">
          {prettyArgs(approval.call.args)}
        </pre>
      )}
      <div className="flex gap-2">
        <Button size="sm" disabled={busy} onClick={() => void decide('allow')}>
          <Check size={13} /> 許可
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={busy}
          onClick={() => void decide('allow-conversation')}
          title={
            code && code.perms.length > 0
              ? '権限を宣言した実行は毎回確認します(権限なしの実行だけ自動になります)'
              : undefined
          }
        >
          この会話では常に許可
        </Button>
        <Button size="sm" variant="danger" disabled={busy} onClick={() => void decide('deny')}>
          <X size={13} /> 拒否
        </Button>
      </div>
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void decide('deny');
          }
        }}
        disabled={busy}
        aria-label="拒否の理由"
        placeholder="拒否の理由(任意。モデルに伝わり、応答は続きます。Enter で拒否)"
        className="border-border bg-surface placeholder:text-fg-muted/70 mt-2 w-full rounded-md border px-2 py-1 text-xs focus:outline-none"
      />
    </div>
  );
}

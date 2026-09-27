import { useQueryClient } from '@tanstack/react-query';
import { Download, GitBranch, Loader2, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { useCallback, useRef, useState, type DragEvent } from 'react';
import type { AttachmentRef } from '@shared/schemas';
import { Button } from '@renderer/components/ui/button';
import { Select } from '@renderer/components/ui/input';
import { addFile } from '@renderer/lib/attachments';
import { invoke } from '@renderer/lib/ipc';
import {
  invalidateConversationView,
  keys,
  useBranches,
  useCapabilities,
  useConversation,
  useConversationMutations,
  useMessagePath,
  useModels,
  useProfiles,
} from '@renderer/lib/queries';
import { cn } from '@renderer/lib/utils';
import { useStreamStore } from '@renderer/state/stream-store';
import { useUiStore } from '@renderer/state/ui-store';
import type { PendingAttachment } from './AttachmentChips';
import { Composer } from './Composer';
import { ConversationSettings } from './ConversationSettings';
import { MessageList } from './MessageList';

export function ChatPane({ conversationId }: { conversationId: string }) {
  const qc = useQueryClient();
  const conv = useConversation(conversationId);
  const path = useMessagePath(conversationId);
  const profiles = useProfiles();
  const models = useModels(conv.data?.serverProfileId ?? null);
  const { update } = useConversationMutations();
  const runningRunId = useStreamStore((s) => s.running[conversationId]);
  const begin = useStreamStore((s) => s.begin);
  const settingsOpen = useUiStore((s) => s.conversationSettingsOpen);
  const setSettingsOpen = useUiStore((s) => s.setConversationSettingsOpen);
  const [sendError, setSendError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const branches = useBranches(conversationId);
  const [pending, setPendingState] = useState<PendingAttachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const caps = useCapabilities(conv.data?.serverProfileId ?? null, conv.data?.model ?? null);
  // 手動分岐(M8): 「ここから分岐」で active leaf を戻し、続きの入力を差し替えてもらう
  const [branching, setBranching] = useState<{
    assistantId: string;
    previousLeafId: string | null;
    count: number;
  } | null>(null);
  const [draft, setDraft] = useState<{ key: number; text: string }>({ key: 0, text: '' });

  const c = conv.data;
  const canSend = !!c?.serverProfileId && !!c.model;
  const setPending = useCallback(
    (updater: (prev: PendingAttachment[]) => PendingAttachment[]) => setPendingState(updater),
    [],
  );

  // 会話を切り替えたら分岐作成の状態は破棄する(leaf は戻さない。分岐ナビから戻れる)
  const [branchingConv, setBranchingConv] = useState(conversationId);
  if (branchingConv !== conversationId) {
    setBranchingConv(conversationId);
    setBranching(null);
  }

  // ドラッグ&ドロップ(チャット画面全体で受ける)
  const onDragEnter = (e: DragEvent<HTMLDivElement>) => {
    if (!e.dataTransfer.types.includes('Files')) return;
    dragDepth.current++;
    setDragging(true);
  };
  const onDragLeave = () => {
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    const files = [...e.dataTransfer.files];
    if (files.length === 0 || !canSend) return;
    void (async () => {
      for (const f of files) {
        try {
          const a = await addFile(f);
          setPendingState((prev) =>
            prev.some((p) => p.attachment.id === a.id)
              ? prev
              : [...prev, { attachment: a, sendMode: 'tools' }],
          );
        } catch (err) {
          setSendError(`${f.name}: ${(err as Error).message}`);
        }
      }
    })();
  };

  const send = async (text: string, attachments: AttachmentRef[]) => {
    setSendError(null);
    try {
      const handle = await invoke('chat:send', { conversationId, text, attachments });
      setBranching(null);
      begin(handle);
      await invalidateConversationView(qc, conversationId);
      await qc.invalidateQueries({ queryKey: keys.conversations });
    } catch (e) {
      setSendError((e as Error).message);
    }
  };

  /** assistant 応答の直後から分岐: leaf を戻し、元の続きのユーザー入力と添付をプリフィルする */
  const branchFrom = async (assistantId: string) => {
    if (!c) return;
    setSendError(null);
    const msgs = path.data ?? [];
    const idx = msgs.findIndex((m) => m.id === assistantId);
    if (idx < 0) return;
    const rest = msgs.slice(idx + 1);
    const nextUser = rest.find((m) => m.role === 'user' && m.kind === 'normal');
    try {
      let text = '';
      const prefill: PendingAttachment[] = [];
      if (nextUser) {
        text = nextUser.parts
          .filter((p) => p.type === 'text')
          .map((p) => p.text)
          .join('\n');
        for (const p of nextUser.parts) {
          if (p.type === 'text' || p.type === 'reasoning') continue;
          const a = await invoke('attachments:get', { id: p.attachmentId });
          // 自動生成されたコンタクトシート等の派生物は引き継がない(送信時に作り直される)
          if (!a || a.meta.derivedFrom) continue;
          prefill.push({
            attachment: a,
            sendMode: p.type === 'video' && p.sendMode ? p.sendMode : 'tools',
            range: p.type === 'video' ? p.range : undefined,
          });
        }
      }
      // 送信直後はキャッシュの activeLeafId が古いことがあるので main から取り直す
      const fresh = await invoke('conversations:get', { id: conversationId });
      const previousLeafId = branching?.previousLeafId ?? fresh?.activeLeafId ?? c.activeLeafId;
      await update.mutateAsync({ id: conversationId, patch: { activeLeafId: assistantId } });
      await invalidateConversationView(qc, conversationId);
      setPendingState(prefill);
      setDraft((d) => ({ key: d.key + 1, text }));
      setBranching({ assistantId, previousLeafId, count: rest.length });
    } catch (e) {
      setSendError((e as Error).message);
    }
  };

  const cancelBranching = async () => {
    if (!branching) return;
    try {
      await update.mutateAsync({
        id: conversationId,
        patch: { activeLeafId: branching.previousLeafId },
      });
      await invalidateConversationView(qc, conversationId);
    } catch (e) {
      setSendError((e as Error).message);
    }
    setBranching(null);
    setPendingState([]);
    setDraft((d) => ({ key: d.key + 1, text: '' }));
  };

  const regenerate = async (messageId: string) => {
    setSendError(null);
    try {
      const handle = await invoke('chat:regenerate', { messageId });
      begin(handle);
      await invalidateConversationView(qc, conversationId);
    } catch (e) {
      setSendError((e as Error).message);
    }
  };

  const edit = async (messageId: string, text: string) => {
    setSendError(null);
    try {
      const handle = await invoke('chat:edit', { messageId, text });
      begin(handle);
      await invalidateConversationView(qc, conversationId);
    } catch (e) {
      setSendError((e as Error).message);
    }
  };

  const switchBranch = async (messageId: string) => {
    setSendError(null);
    try {
      const conv = await invoke('messages:switchBranch', { conversationId, messageId });
      qc.setQueryData(keys.conversation(conversationId), conv);
      await invalidateConversationView(qc, conversationId);
    } catch (e) {
      setSendError((e as Error).message);
    }
  };

  const exportAs = async (format: 'markdown' | 'json') => {
    setSendError(null);
    try {
      const { fileName, content } = await invoke('conversations:export', {
        id: conversationId,
        format,
      });
      const saved = await invoke('files:save', { fileName, content });
      if (saved) setNotice(`保存しました: ${saved}`);
    } catch (e) {
      setSendError((e as Error).message);
    }
  };

  const abort = () => {
    if (runningRunId) void invoke('chat:abort', { runId: runningRunId });
  };

  if (!c)
    return (
      <div className="text-fg-muted flex flex-1 items-center justify-center text-sm">
        読み込み中…
      </div>
    );

  return (
    <div className="flex min-w-0 flex-1">
      <div
        className="relative flex min-w-0 flex-1 flex-col"
        onDragEnter={onDragEnter}
        onDragOver={(e) => e.preventDefault()}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <header className="border-border flex items-center gap-2 border-b px-4 py-2">
          <Select
            className="w-44"
            value={c.serverProfileId ?? ''}
            onChange={(e) => {
              const id = e.target.value || null;
              const p = profiles.data?.find((x) => x.id === id);
              update.mutate({
                id: c.id,
                patch: { serverProfileId: id, model: p?.defaultModel ?? null },
              });
            }}
          >
            <option value="">サーバーを選択</option>
            {profiles.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
          <Select
            className="w-64"
            value={c.model ?? ''}
            disabled={!c.serverProfileId}
            onChange={(e) => update.mutate({ id: c.id, patch: { model: e.target.value || null } })}
          >
            <option value="">
              {models.isPending && c.serverProfileId ? 'モデル取得中…' : 'モデルを選択'}
            </option>
            {c.model && !models.data?.some((m) => m.id === c.model) && (
              <option value={c.model}>{c.model}</option>
            )}
            {models.data?.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </Select>
          {models.isFetching && (
            <span className="text-fg-muted flex items-center gap-1 text-xs">
              <Loader2 size={14} className="animate-spin" /> モデル取得中
            </span>
          )}
          {models.isError && !models.isFetching && (
            <span className="flex min-w-0 items-center gap-1 text-xs text-red-400">
              <span className="truncate" title={String(models.error)}>
                モデル一覧を取得できません
              </span>
              <Button variant="ghost" size="sm" onClick={() => void models.refetch()}>
                <RefreshCw size={12} /> 再試行
              </Button>
            </span>
          )}
          <div className="flex-1" />
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <Button variant="ghost" size="icon" aria-label="エクスポート">
                <Download size={16} />
              </Button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={4}
                className="border-border bg-surface-2 z-50 min-w-44 rounded-md border p-1 text-sm shadow-lg"
              >
                <DropdownMenu.Item
                  className="hover:bg-surface-3 cursor-pointer rounded px-2 py-1.5 outline-none"
                  onSelect={() => void exportAs('markdown')}
                >
                  Markdown で保存(表示中の分岐)
                </DropdownMenu.Item>
                <DropdownMenu.Item
                  className="hover:bg-surface-3 cursor-pointer rounded px-2 py-1.5 outline-none"
                  onSelect={() => void exportAs('json')}
                >
                  JSON で保存(全分岐)
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
          <Button
            variant="ghost"
            size="icon"
            aria-label="会話の設定"
            className={cn(settingsOpen && 'bg-surface-3 text-fg')}
            onClick={() => setSettingsOpen(!settingsOpen)}
          >
            <SlidersHorizontal size={16} />
          </Button>
        </header>
        <MessageList
          conversationId={conversationId}
          messages={path.data ?? []}
          branches={branches.data ?? {}}
          onRegenerate={(id) => void regenerate(id)}
          onSwitchBranch={(id) => void switchBranch(id)}
          onEdit={(id, text) => void edit(id, text)}
          onBranchFrom={(id) => void branchFrom(id)}
        />
        {sendError && <div className="px-4 py-1 text-xs text-red-400">{sendError}</div>}
        {notice && (
          <div className="text-fg-muted flex items-center gap-2 px-4 py-1 text-xs">
            <span className="truncate">{notice}</span>
            <button type="button" className="hover:text-fg" onClick={() => setNotice(null)}>
              閉じる
            </button>
          </div>
        )}
        <Composer
          conversation={c}
          disabled={!canSend}
          running={!!runningRunId}
          nativeVideo={caps.data?.video === 'native'}
          toolsSupported={caps.data?.tools ?? true}
          pending={pending}
          setPending={setPending}
          onSend={(t, refs) => void send(t, refs)}
          onAbort={abort}
          draft={draft}
          banner={
            branching && (
              <div
                className="border-accent/40 bg-accent/10 mb-2 flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs"
                role="status"
              >
                <GitBranch size={13} className="text-accent shrink-0" />
                <span className="min-w-0 flex-1">
                  分岐を作成中: 送信すると、この応答の続きとして新しい分岐になります(元の続き{' '}
                  {branching.count} 件は分岐ナビで戻れます)
                </span>
                <Button variant="ghost" size="sm" onClick={() => void cancelBranching()}>
                  やめる
                </Button>
              </div>
            )
          }
        />
        {dragging && (
          <div className="bg-accent/10 border-accent pointer-events-none absolute inset-0 z-10 flex items-center justify-center border-2 border-dashed text-sm">
            ファイルをドロップして添付
          </div>
        )}
      </div>
      {settingsOpen && <ConversationSettings key={c.id} conversation={c} />}
    </div>
  );
}

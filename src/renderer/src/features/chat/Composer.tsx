import { Loader2, Paperclip, SendHorizontal, Square } from 'lucide-react';
import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react';
import type { AttachmentRef } from '@shared/schemas';
import { Button } from '@renderer/components/ui/button';
import { addFile } from '@renderer/lib/attachments';
import { AttachmentChips, toRefs, type PendingAttachment } from './AttachmentChips';

export interface ComposerProps {
  disabled: boolean;
  running: boolean;
  nativeVideo: boolean;
  pending: PendingAttachment[];
  setPending: (updater: (prev: PendingAttachment[]) => PendingAttachment[]) => void;
  onSend: (text: string, attachments: AttachmentRef[]) => void;
  onAbort: () => void;
}

export function Composer({
  disabled,
  running,
  nativeVideo,
  pending,
  setPending,
  onSend,
  onAbort,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [adding, setAdding] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const composing = useRef(false);

  // 高さを内容に合わせる(最大 12 行程度)
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
  }, [text]);

  const addFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setError(null);
    setAdding((n) => n + files.length);
    for (const f of files) {
      try {
        const a = await addFile(f);
        setPending((prev) =>
          prev.some((p) => p.attachment.id === a.id)
            ? prev
            : [...prev, { attachment: a, sendMode: 'tools' }],
        );
      } catch (e) {
        setError(`${f.name}: ${(e as Error).message}`);
      } finally {
        setAdding((n) => n - 1);
      }
    }
  };

  const submit = () => {
    const t = text.trim();
    if ((!t && pending.length === 0) || disabled || running || adding > 0) return;
    onSend(t, toRefs(pending));
    setText('');
    setPending(() => []);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // IME 変換中の Enter は送信しない
    if (e.key === 'Enter' && !e.shiftKey && !composing.current && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length > 0) {
      e.preventDefault();
      void addFiles(files);
    }
  };

  const canSend =
    !disabled && !running && adding === 0 && (text.trim().length > 0 || pending.length > 0);

  return (
    <div className="border-border bg-surface border-t px-4 py-3">
      <div className="mx-auto max-w-4xl">
        <AttachmentChips
          items={pending}
          nativeVideo={nativeVideo}
          onRemove={(id) => setPending((prev) => prev.filter((p) => p.attachment.id !== id))}
          onToggleMode={(id) =>
            setPending((prev) =>
              prev.map((p) =>
                p.attachment.id === id
                  ? { ...p, sendMode: p.sendMode === 'native' ? 'tools' : 'native' }
                  : p,
              ),
            )
          }
        />
        {error && <div className="px-1 pb-1 text-xs text-red-400">{error}</div>}
        <div className="border-border bg-surface-2 focus-within:ring-accent/50 flex items-end gap-2 rounded-lg border p-2 focus-within:ring-2">
          <input
            ref={fileInput}
            type="file"
            multiple
            accept="image/*,video/*,audio/*,.pdf,.txt,.md"
            className="hidden"
            onChange={(e) => {
              void addFiles([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label="ファイルを添付"
            disabled={disabled}
            onClick={() => fileInput.current?.click()}
          >
            {adding > 0 ? <Loader2 size={15} className="animate-spin" /> : <Paperclip size={15} />}
          </Button>
          <textarea
            ref={ref}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onCompositionStart={() => (composing.current = true)}
            onCompositionEnd={() => (composing.current = false)}
            placeholder={
              disabled
                ? 'サーバープロファイルとモデルを選択してください'
                : 'メッセージを入力 (Enter で送信、Shift+Enter で改行、画像や動画はドロップか貼り付け)'
            }
            disabled={disabled}
            rows={1}
            className="placeholder:text-fg-muted/60 max-h-[280px] min-h-[36px] flex-1 resize-none bg-transparent px-1 py-1.5 text-[15px] leading-relaxed focus:outline-none disabled:opacity-50"
          />
          {running ? (
            <Button variant="danger" size="icon" onClick={onAbort} aria-label="停止">
              <Square size={14} />
            </Button>
          ) : (
            <Button size="icon" onClick={submit} disabled={!canSend} aria-label="送信">
              <SendHorizontal size={15} />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

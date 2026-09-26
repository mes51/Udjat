import { SendHorizontal, Square } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@renderer/components/ui/button';

export function Composer({
  disabled,
  running,
  onSend,
  onAbort,
}: {
  disabled: boolean;
  running: boolean;
  onSend: (text: string) => void;
  onAbort: () => void;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);

  // 高さを内容に合わせる(最大 12 行程度)
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 280)}px`;
  }, [text]);

  const submit = () => {
    const t = text.trim();
    if (!t || disabled || running) return;
    onSend(t);
    setText('');
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // IME 変換中の Enter は送信しない
    if (e.key === 'Enter' && !e.shiftKey && !composing.current && !e.nativeEvent.isComposing) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="border-border bg-surface border-t px-4 py-3">
      <div className="border-border bg-surface-2 focus-within:ring-accent/50 mx-auto flex max-w-4xl items-end gap-2 rounded-lg border p-2 focus-within:ring-2">
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={() => (composing.current = false)}
          placeholder={
            disabled
              ? 'サーバープロファイルとモデルを選択してください'
              : 'メッセージを入力 (Enter で送信、Shift+Enter で改行)'
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
          <Button
            size="icon"
            onClick={submit}
            disabled={disabled || text.trim().length === 0}
            aria-label="送信"
          >
            <SendHorizontal size={15} />
          </Button>
        )}
      </div>
    </div>
  );
}

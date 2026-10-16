import { CaseSensitive, ChevronDown, ChevronUp, Regex, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { Button } from '@renderer/components/ui/button';
import { cn } from '@renderer/lib/utils';

/**
 * 会話内検索(M22)。Ctrl+F で開き、表示中の分岐のメッセージ本文から一致箇所を探して
 * ハイライトする。件数と現在位置は MessageList 側が DOM を走査して setResult で知らせる。
 */

interface ChatSearchStore {
  open: boolean;
  query: string;
  caseSensitive: boolean;
  regex: boolean;
  /** 一致件数(MessageList が更新) */
  total: number;
  /** 現在位置(0 始まり)。一致が無ければ 0 のまま */
  current: number;
  /** 正規表現が不正な時のメッセージ */
  error: string | null;
  /** 入力欄にフォーカスを要求した回数(開く・Ctrl+F の再押下で増える) */
  focusRequest: number;
  show: () => void;
  hide: () => void;
  setQuery: (q: string) => void;
  toggleCase: () => void;
  toggleRegex: () => void;
  setResult: (total: number, error: string | null) => void;
  step: (delta: number) => void;
}

export const useChatSearch = create<ChatSearchStore>((set) => ({
  open: false,
  query: '',
  caseSensitive: false,
  regex: false,
  total: 0,
  current: 0,
  error: null,
  focusRequest: 0,
  show: () => set((s) => ({ open: true, focusRequest: s.focusRequest + 1 })),
  hide: () => set({ open: false, total: 0, current: 0, error: null }),
  setQuery: (query) => set({ query, current: 0 }),
  toggleCase: () => set((s) => ({ caseSensitive: !s.caseSensitive, current: 0 })),
  toggleRegex: () => set((s) => ({ regex: !s.regex, current: 0 })),
  setResult: (total, error) =>
    set((s) => ({ total, error, current: total === 0 ? 0 : Math.min(s.current, total - 1) })),
  step: (delta) =>
    set((s) => (s.total === 0 ? s : { current: (s.current + delta + s.total) % s.total })),
}));

function Toggle({
  on,
  label,
  onClick,
  children,
}: {
  on: boolean;
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors',
        on ? 'bg-accent/20 text-accent' : 'text-fg-muted hover:bg-surface-3 hover:text-fg',
      )}
    >
      {children}
    </button>
  );
}

export function ChatSearchBar() {
  const s = useChatSearch();
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (s.open && s.focusRequest > 0) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [s.open, s.focusRequest]);
  if (!s.open) return null;
  const hasQuery = s.query !== '';
  return (
    <div
      role="search"
      aria-label="会話内検索"
      className="border-border bg-surface-2 absolute top-14 right-6 z-20 flex w-[26rem] max-w-[calc(100%-3rem)] flex-col gap-1 rounded-md border px-2 py-1.5 shadow-lg"
    >
      <div className="flex items-center gap-1">
        <input
          ref={inputRef}
          value={s.query}
          onChange={(e) => s.setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              s.step(e.shiftKey ? -1 : 1);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              s.hide();
            }
          }}
          placeholder="会話内を検索(Enter で次、Shift+Enter で前)"
          aria-label="検索語"
          spellCheck={false}
          className={cn(
            'placeholder:text-fg-muted/70 h-7 min-w-0 flex-1 bg-transparent px-1 text-sm focus:outline-none',
            s.error && 'text-danger',
          )}
        />
        <Toggle on={s.caseSensitive} label="大文字と小文字を区別" onClick={s.toggleCase}>
          <CaseSensitive size={15} />
        </Toggle>
        <Toggle on={s.regex} label="正規表現を使う" onClick={s.toggleRegex}>
          <Regex size={14} />
        </Toggle>
        <span
          className={cn(
            'w-14 shrink-0 text-center text-[11px] tabular-nums',
            hasQuery && s.total === 0 && !s.error ? 'text-danger' : 'text-fg-muted',
          )}
          aria-live="polite"
        >
          {hasQuery && !s.error ? (s.total === 0 ? '0 件' : `${s.current + 1}/${s.total}`) : ''}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="前の一致"
          disabled={s.total === 0}
          onClick={() => s.step(-1)}
        >
          <ChevronUp size={14} />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="次の一致"
          disabled={s.total === 0}
          onClick={() => s.step(1)}
        >
          <ChevronDown size={14} />
        </Button>
        <Button variant="ghost" size="icon-sm" aria-label="検索を閉じる" onClick={s.hide}>
          <X size={14} />
        </Button>
      </div>
      {s.error && <div className="text-danger px-1 text-[11px]">正規表現が不正です: {s.error}</div>}
    </div>
  );
}

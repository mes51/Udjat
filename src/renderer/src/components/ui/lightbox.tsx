import { Dialog as RadixDialog } from 'radix-ui';
import { ChevronLeft, ChevronRight, Download, ExternalLink, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { mediaUrl } from '@renderer/lib/attachments';
import { invoke } from '@renderer/lib/ipc';
import { cn } from '@renderer/lib/utils';
import { Button } from './button';

/**
 * 添付のポップアップ表示(M21)。ユーザーの添付、ツールがモデルに渡した画像・動画をクリックで拡大し、
 * 同じメッセージ内の他の項目へ ← → で移動できる。画像・動画・音声以外は情報と「開く / 保存」だけ。
 */

export interface LightboxItem {
  attachmentId: string;
  kind: 'image' | 'video' | 'audio' | 'file';
  name: string;
  /** 補足(例: "frame @00:12"、"contact sheet")。ツールが付けたラベル */
  label?: string | undefined;
}

interface LightboxStore {
  items: LightboxItem[];
  index: number;
  open: (items: LightboxItem[], index: number) => void;
  close: () => void;
  step: (delta: number) => void;
}

export const useLightbox = create<LightboxStore>((set) => ({
  items: [],
  index: 0,
  open: (items, index) => set({ items, index: Math.max(0, Math.min(index, items.length - 1)) }),
  close: () => set({ items: [] }),
  step: (delta) =>
    set((s) =>
      s.items.length === 0 ? s : { index: (s.index + delta + s.items.length) % s.items.length },
    ),
}));

export function Lightbox() {
  const { items, index, close, step } = useLightbox();
  const item = items[index];
  // 項目が変わったら保存結果などのメッセージを消す(描画中の setState で同期する)
  const [msgState, setMsgState] = useState<{ id: string; text: string } | null>(null);
  const msg = msgState && msgState.id === item?.attachmentId ? msgState.text : null;
  const setMsg = (text: string | null) =>
    setMsgState(text && item ? { id: item.attachmentId, text } : null);
  useEffect(() => {
    if (!item) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') step(-1);
      else if (e.key === 'ArrowRight') step(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [item, step]);
  if (!item) return null;

  const saveAs = async () => {
    try {
      const path = await invoke('attachments:saveAs', { id: item.attachmentId });
      if (path) setMsg(`保存しました: ${path}`);
    } catch (e) {
      setMsg(String(e));
    }
  };
  const openExternal = async () => {
    try {
      await invoke('attachments:open', { id: item.attachmentId });
    } catch (e) {
      setMsg(String(e));
    }
  };
  const caption = [item.label, item.name].filter(Boolean).join(' · ');

  return (
    <RadixDialog.Root open onOpenChange={(o) => !o && close()}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="fixed inset-0 z-[60] bg-black/80" />
        <RadixDialog.Content
          onOpenAutoFocus={(e) => e.preventDefault()}
          className="fixed inset-0 z-[70] flex flex-col items-center justify-center p-6 focus:outline-none"
          onClick={(e) => {
            if (e.target === e.currentTarget) close();
          }}
        >
          <RadixDialog.Title className="sr-only">{caption || '添付'}</RadixDialog.Title>
          <RadixDialog.Description className="sr-only">添付のプレビュー</RadixDialog.Description>
          <div className="absolute top-3 right-3 flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              className="text-white/90"
              onClick={() => void openExternal()}
            >
              <ExternalLink size={13} /> 開く
            </Button>
            <Button
              variant="ghost"
              size="sm"
              className="text-white/90"
              onClick={() => void saveAs()}
            >
              <Download size={13} /> 保存…
            </Button>
            <RadixDialog.Close asChild>
              <Button variant="ghost" size="icon" className="text-white/90" aria-label="閉じる">
                <X size={18} />
              </Button>
            </RadixDialog.Close>
          </div>
          {items.length > 1 && (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="absolute top-1/2 left-3 -translate-y-1/2 text-white/90"
                aria-label="前へ"
                onClick={() => step(-1)}
              >
                <ChevronLeft size={22} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="absolute top-1/2 right-3 -translate-y-1/2 text-white/90"
                aria-label="次へ"
                onClick={() => step(1)}
              >
                <ChevronRight size={22} />
              </Button>
            </>
          )}
          <div
            className="flex max-h-[85vh] max-w-[92vw] items-center justify-center"
            onClick={(e) => e.stopPropagation()}
          >
            {item.kind === 'image' && (
              <img
                key={item.attachmentId}
                src={mediaUrl(item.attachmentId)}
                alt={item.name}
                className="max-h-[85vh] max-w-[92vw] rounded-md object-contain shadow-2xl"
              />
            )}
            {item.kind === 'video' && (
              <video
                key={item.attachmentId}
                src={mediaUrl(item.attachmentId)}
                controls
                autoPlay
                className="max-h-[85vh] max-w-[92vw] rounded-md shadow-2xl"
              />
            )}
            {item.kind === 'audio' && (
              <audio key={item.attachmentId} src={mediaUrl(item.attachmentId)} controls autoPlay />
            )}
            {item.kind === 'file' && (
              <div className="bg-surface-2 border-border rounded-md border px-6 py-5 text-sm shadow-2xl">
                <div className="font-medium">{item.name}</div>
                <div className="text-fg-muted mt-1 text-xs">
                  プレビューできない種類です。「開く」で既定のアプリで開くか、「保存…」で書き出してください
                </div>
              </div>
            )}
          </div>
          <div
            className={cn(
              'mt-3 max-w-[92vw] truncate rounded-md bg-black/50 px-3 py-1 text-xs text-white/90',
            )}
          >
            {caption}
            {items.length > 1 && (
              <span className="ml-2 opacity-70">
                {index + 1} / {items.length}
              </span>
            )}
            {msg && <span className="ml-2 opacity-70">{msg}</span>}
          </div>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

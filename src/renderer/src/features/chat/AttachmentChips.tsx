import { Film, FileIcon, Image as ImageIcon, Music, Scissors, X } from 'lucide-react';
import { useState } from 'react';
import type { Attachment, AttachmentRef, VideoRange } from '@shared/schemas';
import { Button } from '@renderer/components/ui/button';
import { formatBytes, formatSeconds, mediaUrl } from '@renderer/lib/attachments';
import { cn } from '@renderer/lib/utils';

export interface PendingAttachment {
  attachment: Attachment;
  sendMode: 'tools' | 'native';
  /** 動画の対象区間(省略時は全体 / 先頭から) */
  range?: VideoRange | undefined;
}

export function toRefs(list: PendingAttachment[]): AttachmentRef[] {
  return list.map((p) => ({
    id: p.attachment.id,
    ...(p.attachment.meta.kind === 'video' ? { sendMode: p.sendMode } : {}),
    ...(p.attachment.meta.kind === 'video' && p.range ? { range: p.range } : {}),
  }));
}

/** ms を "m:ss" 表記に(区間エディタの入出力用。parseTimeMs で読み戻せる) */
export function clock(ms: number): string {
  const s = Math.floor(ms / 1000);
  const frac = Math.round((ms % 1000) / 100);
  const base = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return frac > 0 ? `${base}.${frac}` : base;
}

/** "83" / "1:23" / "1:23.5" / "1:02:03" を ms に。不正なら null */
export function parseTimeMs(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  const parts = t.split(':');
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null;
  let sec = 0;
  for (const p of parts) sec = sec * 60 + Number(p);
  return Math.round(sec * 1000);
}

/** 動画チップの区間エディタ */
function RangeEditor({
  durationMs,
  range,
  onApply,
  onClose,
}: {
  durationMs: number | undefined;
  range: VideoRange | undefined;
  onApply: (r: VideoRange | undefined) => void;
  onClose: () => void;
}) {
  const [start, setStart] = useState(range ? clock(range.startMs) : '0:00');
  const [end, setEnd] = useState(
    range ? clock(range.endMs) : durationMs !== undefined ? clock(durationMs) : ''
  );
  const s = parseTimeMs(start);
  const e = parseTimeMs(end);
  const valid =
    s !== null &&
    e !== null &&
    e > s &&
    (durationMs === undefined || (s < durationMs && e <= durationMs + 999));
  const inputCls =
    'border-border bg-surface-2 focus-visible:ring-accent/60 w-16 rounded border px-1 py-0.5 text-[11px] focus-visible:ring-1 focus-visible:outline-none';
  return (
    <div className="flex items-center gap-1" onKeyDown={(ev) => ev.key === 'Escape' && onClose()}>
      <input
        aria-label="開始"
        className={inputCls}
        value={start}
        onChange={(ev) => setStart(ev.target.value)}
        placeholder="0:00"
      />
      <span className="text-fg-muted">-</span>
      <input
        aria-label="終了"
        className={inputCls}
        value={end}
        onChange={(ev) => setEnd(ev.target.value)}
        placeholder="1:30"
      />
      <Button
        size="sm"
        className="h-6 px-1.5 text-[11px]"
        disabled={!valid}
        onClick={() => valid && onApply({ startMs: s, endMs: Math.min(e, durationMs ?? e) })}
      >
        適用
      </Button>
      {range && (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-1.5 text-[11px]"
          onClick={() => onApply(undefined)}
        >
          解除
        </Button>
      )}
    </div>
  );
}

export function AttachmentChips({
  items,
  nativeVideo,
  onRemove,
  onToggleMode,
  onSetRange,
}: {
  items: PendingAttachment[];
  /** 選択中モデルが動画をそのまま受け取れるか */
  nativeVideo: boolean;
  onRemove: (id: string) => void;
  onToggleMode: (id: string) => void;
  onSetRange: (id: string, range: VideoRange | undefined) => void;
}) {
  const [editingRange, setEditingRange] = useState<string | null>(null);
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-1 pb-2">
      {items.map(({ attachment: a, sendMode, range }) => {
        const kind = a.meta.kind;
        return (
          <div
            key={a.id}
            className="border-border bg-surface flex flex-wrap items-center gap-2 rounded-md border py-1 pr-1 pl-1.5 text-xs"
          >
            {kind === 'image' ? (
              <img
                src={mediaUrl(a.id)}
                alt={a.originalName}
                className="h-8 w-8 rounded object-cover"
              />
            ) : kind === 'video' ? (
              <Film size={16} className="text-fg-muted" />
            ) : kind === 'audio' ? (
              <Music size={16} className="text-fg-muted" />
            ) : (
              <FileIcon size={16} className="text-fg-muted" />
            )}
            <div className="max-w-56">
              <div className="truncate">{a.originalName}</div>
              <div className="text-fg-muted/80 text-[10px]">
                {formatBytes(a.size)}
                {kind === 'video' &&
                  a.meta.durationMs !== undefined &&
                  ` · ${formatSeconds(a.meta.durationMs)}`}
                {a.meta.width && a.meta.height && ` · ${a.meta.width}x${a.meta.height}`}
                {a.meta.probeError && ' · 解析失敗'}
              </div>
            </div>
            {kind === 'video' && (
              <button
                type="button"
                title={
                  nativeVideo
                    ? 'ツールで参照: LLM がフレームを取りに行く / そのまま送る: 縮小した動画を入力として渡す'
                    : 'このモデルは動画を直接受け取れないため、ツール参照のみ'
                }
                disabled={!nativeVideo}
                onClick={() => onToggleMode(a.id)}
                className={cn(
                  'rounded border px-1.5 py-0.5 text-[10px]',
                  sendMode === 'native'
                    ? 'border-accent text-accent'
                    : 'border-border text-fg-muted',
                  !nativeVideo && 'opacity-50',
                )}
              >
                {sendMode === 'native' ? 'そのまま送る' : 'ツールで参照'}
              </button>
            )}
            {kind === 'video' && !a.meta.probeError && (
              <button
                type="button"
                title={
                  sendMode === 'native'
                    ? 'モデルに渡す区間(先頭から最大秒数まで)を指定する'
                    : '自動添付するコンタクトシートの区間を指定する'
                }
                aria-label="範囲"
                onClick={() => setEditingRange(editingRange === a.id ? null : a.id)}
                className={cn(
                  'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px]',
                  range ? 'border-accent text-accent' : 'border-border text-fg-muted',
                )}
              >
                <Scissors size={10} />
                {range ? `${clock(range.startMs)}-${clock(range.endMs)}` : '範囲'}
              </button>
            )}
            {kind === 'video' && editingRange === a.id && (
              <RangeEditor
                durationMs={a.meta.durationMs}
                range={range}
                onApply={(r) => {
                  onSetRange(a.id, r);
                  setEditingRange(null);
                }}
                onClose={() => setEditingRange(null)}
              />
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="添付を外す"
              onClick={() => onRemove(a.id)}
            >
              <X size={12} />
            </Button>
          </div>
        );
      })}
    </div>
  );
}

/** メッセージ内の添付パートの表示 */
export function PartMedia({
  type,
  attachmentId,
  name,
}: {
  type: 'image' | 'video' | 'audio' | 'file';
  attachmentId: string;
  name?: string | undefined;
}) {
  if (type === 'image') {
    return (
      <a href={mediaUrl(attachmentId)} target="_blank" rel="noreferrer" title={name}>
        <img
          src={mediaUrl(attachmentId)}
          alt={name ?? ''}
          className="border-border max-h-72 max-w-full rounded-md border object-contain"
          loading="lazy"
        />
      </a>
    );
  }
  if (type === 'video') {
    return (
      <div className="border-border bg-surface inline-block max-w-full rounded-md border p-1">
        <video
          src={mediaUrl(attachmentId)}
          controls
          preload="metadata"
          className="max-h-64 max-w-full rounded"
        />
        <div className="text-fg-muted flex items-center gap-1 px-1 pt-1 text-[11px]">
          <Film size={12} /> {name ?? attachmentId}
        </div>
      </div>
    );
  }
  if (type === 'audio') {
    return (
      <audio src={mediaUrl(attachmentId)} controls preload="metadata" className="max-w-full" />
    );
  }
  return (
    <span className="border-border bg-surface inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs">
      <FileIcon size={13} /> {name ?? attachmentId}
    </span>
  );
}

export function ImageIconSmall() {
  return <ImageIcon size={14} />;
}

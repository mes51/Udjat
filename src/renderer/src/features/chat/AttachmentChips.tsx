import { Film, FileIcon, Image as ImageIcon, Music, X } from 'lucide-react';
import type { Attachment, AttachmentRef } from '@shared/schemas';
import { Button } from '@renderer/components/ui/button';
import { formatBytes, formatSeconds, mediaUrl } from '@renderer/lib/attachments';
import { cn } from '@renderer/lib/utils';

export interface PendingAttachment {
  attachment: Attachment;
  sendMode: 'tools' | 'native';
}

export function toRefs(list: PendingAttachment[]): AttachmentRef[] {
  return list.map((p) => ({
    id: p.attachment.id,
    ...(p.attachment.meta.kind === 'video' ? { sendMode: p.sendMode } : {}),
  }));
}

export function AttachmentChips({
  items,
  nativeVideo,
  onRemove,
  onToggleMode,
}: {
  items: PendingAttachment[];
  /** 選択中モデルが動画をそのまま受け取れるか */
  nativeVideo: boolean;
  onRemove: (id: string) => void;
  onToggleMode: (id: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2 px-1 pb-2">
      {items.map(({ attachment: a, sendMode }) => {
        const kind = a.meta.kind;
        return (
          <div
            key={a.id}
            className="border-border bg-surface flex items-center gap-2 rounded-md border py-1 pr-1 pl-1.5 text-xs"
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

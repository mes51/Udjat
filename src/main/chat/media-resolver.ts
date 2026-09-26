import type { Attachment, Capabilities, Part } from '@shared/schemas';
import type { MediaStore } from '@main/media/store';
import {
  DEFAULT_NATIVE_CLIP,
  fmt,
  type NativeClipOptions,
  type VideoOps,
} from '@main/media/video-ops';
import type { CanonicalMedia } from '@main/providers';

/**
 * メッセージの添付パートを、プロバイダに渡せる形(base64)か、テキスト注記に変換する。
 * 設計は docs/plan/03-video-and-attachments.md。
 */

export interface ResolvedPart {
  text?: string;
  image?: CanonicalMedia;
  video?: CanonicalMedia;
}

export interface MediaResolverOptions {
  /** 画像の長辺上限(送信前に縮小) */
  imageMaxEdge?: number;
  nativeClip?: NativeClipOptions;
}

export function videoNote(a: Attachment): string {
  const dur = a.meta.durationMs !== undefined ? fmt(a.meta.durationMs) : '?';
  const res = a.meta.width && a.meta.height ? `${a.meta.width}x${a.meta.height}` : '?';
  const fps = a.meta.fps !== undefined ? `${a.meta.fps.toFixed(1)}fps` : '?fps';
  const audio = a.meta.hasAudio ? 'yes' : 'no';
  return (
    `[attached video: video_id=${a.id}, name="${a.originalName}", duration=${dur}, ${res}, ${fps}, audio=${audio}]\n` +
    `Use the video_* tools (video_info, video_scenes, video_contact_sheet, video_frames) with this video_id to inspect it.`
  );
}

export class MediaResolver {
  constructor(
    private readonly store: MediaStore,
    private readonly ops: VideoOps,
    private readonly opts: MediaResolverOptions = {},
  ) {}

  async resolve(part: Part, caps: Capabilities, signal?: AbortSignal): Promise<ResolvedPart> {
    if (part.type === 'text' || part.type === 'reasoning') return { text: part.text };
    const a = this.store.get(part.attachmentId);
    if (!a) return { text: `[添付が見つかりません: ${part.name ?? part.attachmentId}]` };

    if (part.type === 'image') {
      const label = a.meta.derivedLabel
        ? `[image: ${a.meta.derivedLabel} of video_id=${a.meta.derivedFrom ?? '?'}]`
        : undefined;
      if (!caps.image)
        return { text: `[添付画像: ${part.name ?? a.originalName}](このモデルは画像を扱えません)` };
      const sendable = await this.ops.resizedImage(a, this.opts.imageMaxEdge ?? 1568, signal);
      const out: ResolvedPart = {
        image: {
          mime: sendable.mime,
          base64: this.store.readBase64(sendable),
          name: a.originalName,
        },
      };
      if (label) out.text = label;
      return out;
    }

    if (part.type === 'video') {
      const out: ResolvedPart = { text: videoNote(a) };
      if (part.sendMode === 'native' && caps.video === 'native') {
        const clip = await this.ops.nativeClip(
          a,
          this.opts.nativeClip ?? DEFAULT_NATIVE_CLIP,
          signal,
        );
        out.video = { mime: clip.mime, base64: this.store.readBase64(clip), name: a.originalName };
        out.text = `[attached video: video_id=${a.id}, name="${a.originalName}"] The video itself is attached (downscaled, first ${(this.opts.nativeClip ?? DEFAULT_NATIVE_CLIP).maxSeconds}s max). The video_* tools are also available for closer inspection.`;
      }
      return out;
    }

    if (part.type === 'audio')
      return { text: `[添付音声: ${part.name ?? a.originalName}](音声入力は未対応)` };
    return { text: `[添付ファイル: ${part.name ?? a.originalName}]` };
  }
}

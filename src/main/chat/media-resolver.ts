import { readFileSync } from 'node:fs';
import type { Attachment, Capabilities, Part } from '@shared/schemas';
import type { PdfService } from '@main/media/pdf';
import type { MediaStore } from '@main/media/store';
import { looksText } from '@main/media/text-files';
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
  audio?: CanonicalMedia;
}

export interface MediaResolverOptions {
  /** 画像の長辺上限(送信前に縮小) */
  imageMaxEdge?: number;
  /** ネイティブ動画入力のクリップ設定。関数なら送信のたびに評価する(設定の反映用) */
  nativeClip?: NativeClipOptions | (() => NativeClipOptions);
  /** 音声入力に送る最大秒数 */
  audioMaxSeconds?: number;
  /** PDF 本文として送る最大文字数 */
  pdfMaxChars?: number;
  /** テキスト系ファイルの本文として送る最大文字数(続きは attachment_text ツール)。関数なら送信のたびに評価 */
  fileMaxChars?: number | (() => number);
}

/** これより大きいテキストファイルは展開しない(attachment_text で読む) */
const MAX_TEXT_FILE_BYTES = 32 * 1024 * 1024;

export function videoNote(a: Attachment, range?: { startMs: number; endMs: number }): string {
  const dur = a.meta.durationMs !== undefined ? fmt(a.meta.durationMs) : '?';
  const res = a.meta.width && a.meta.height ? `${a.meta.width}x${a.meta.height}` : '?';
  const fps = a.meta.fps !== undefined ? `${a.meta.fps.toFixed(1)}fps` : '?fps';
  const audio = a.meta.hasAudio ? 'yes' : 'no';
  const focus = range
    ? ` The user wants you to focus on the range ${fmt(range.startMs)}-${fmt(range.endMs)}.`
    : '';
  return (
    `[attached video: video_id=${a.id}, name="${a.originalName}", duration=${dur}, ${res}, ${fps}, audio=${audio}]\n` +
    `Use the video_* tools (video_info, video_scenes, video_contact_sheet, video_frames) with this video_id to inspect it.${focus}`
  );
}

export class MediaResolver {
  constructor(
    private readonly store: MediaStore,
    private readonly ops: VideoOps,
    private readonly opts: MediaResolverOptions = {},
    private readonly pdf?: PdfService,
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
      const out: ResolvedPart = { text: videoNote(a, part.range) };
      if (part.sendMode === 'native' && caps.video === 'native') {
        const nc = this.opts.nativeClip;
        const opts = typeof nc === 'function' ? nc() : (nc ?? DEFAULT_NATIVE_CLIP);
        const clip = await this.ops.nativeClip(a, opts, signal, part.range);
        out.video = { mime: clip.mime, base64: this.store.readBase64(clip), name: a.originalName };
        const from = clip.meta.derivedLabel ?? '';
        const range = part.range
          ? `the user-selected range ${fmt(part.range.startMs)}-${fmt(part.range.endMs)}`
          : 'the beginning';
        out.text =
          `[attached video: video_id=${a.id}, name="${a.originalName}", full duration=${a.meta.durationMs !== undefined ? fmt(a.meta.durationMs) : '?'}]\n` +
          `The attached video is a downscaled clip (${from}) covering up to ${opts.maxSeconds}s from ${range}. ` +
          `To see other parts of the video, call video_clip(video_id, start, end) (up to ${opts.maxSeconds}s per call); video_contact_sheet / video_frames are also available.`;
      }
      return out;
    }

    if (part.type === 'audio') {
      if (!caps.audio) {
        return {
          text: `[添付音声: ${part.name ?? a.originalName}](このモデル/サーバーは音声入力を扱えません)`,
        };
      }
      const maxSeconds = this.opts.audioMaxSeconds ?? 300;
      const mp3 = await this.ops.nativeAudio(a, maxSeconds, signal);
      const dur = a.meta.durationMs !== undefined ? fmt(a.meta.durationMs) : '?';
      return {
        text: `[attached audio: name="${a.originalName}", duration=${dur}${(a.meta.durationMs ?? 0) > maxSeconds * 1000 ? `, first ${maxSeconds}s only` : ''}]`,
        audio: { mime: mp3.mime, base64: this.store.readBase64(mp3), name: a.originalName },
      };
    }
    if (a.mime === 'application/pdf' && this.pdf) {
      return { text: await this.pdfText(a, signal) };
    }
    return { text: this.fileText(a) };
  }

  /**
   * PDF 以外のファイル添付。テキストとして読めるなら本文を展開して送る(上限あり。続きは attachment_text ツール)。
   * 読めないバイナリは種別と大きさの注記だけにする(M13)
   */
  private fileText(a: Attachment): string {
    const fm = this.opts.fileMaxChars;
    const maxChars = (typeof fm === 'function' ? fm() : fm) || 30_000;
    const head = `[attached file: attachment_id=${a.id}, name="${a.originalName}", mime=${a.mime}, ${a.size} bytes]`;
    let buf: Buffer;
    try {
      buf = readFileSync(this.store.pathOf(a));
    } catch (e) {
      return `${head}\n[読み込みに失敗: ${(e as Error).message.slice(0, 200)}]`;
    }
    if (a.size > MAX_TEXT_FILE_BYTES || !looksText(a.mime, a.originalName, buf.subarray(0, 8192))) {
      return `${head}\n(binary or too large; the content is not included. run_javascript can read it with udjat.readAttachment(attachment_id, "base64"))`;
    }
    const full = buf.toString('utf8');
    const body = full.slice(0, maxChars);
    const truncated = full.length > body.length;
    return (
      `${head} ${full.length} chars${truncated ? `, first ${body.length} shown` : ''}\n` +
      body +
      (truncated
        ? `\n[... truncated at ${body.length} chars. Use attachment_text(attachment_id="${a.id}", offset=${body.length}) to read more]`
        : '')
    );
  }

  private readonly pdfCache = new Map<string, string>();

  /** PDF は本文テキストを送る(上限あり)。図表は pdf_pages ツールで見られる旨を添える */
  private async pdfText(a: Attachment, _signal?: AbortSignal): Promise<string> {
    const maxChars = this.opts.pdfMaxChars ?? 30_000;
    const key = `${a.id}:${maxChars}`;
    const hit = this.pdfCache.get(key);
    if (hit) return hit;
    let body: string;
    let numPages = a.meta.pageCount ?? 0;
    try {
      const r = await this.pdf!.extractText(this.store.pathOf(a));
      numPages = r.numPages;
      const chunks: string[] = [];
      let used = 0;
      let truncatedAt: number | null = null;
      for (const p of r.pages) {
        const block = `--- page ${p.page} ---\n${p.text}`;
        if (used + block.length > maxChars) {
          truncatedAt = p.page;
          break;
        }
        chunks.push(block);
        used += block.length + 1;
      }
      body = chunks.join('\n');
      if (truncatedAt !== null) {
        body += `\n[... truncated: pages ${truncatedAt}-${numPages} omitted (${maxChars} chars limit). Use pdf_text to read specific pages.]`;
      }
      if (!body.trim())
        body = '[no extractable text: scanned PDF? Use pdf_pages to view pages as images]';
    } catch (e) {
      body = `[PDF のテキスト抽出に失敗: ${(e as Error).message.slice(0, 200)}]`;
    }
    const text =
      `[attached pdf: pdf_id=${a.id}, name="${a.originalName}", pages=${numPages}]\n` +
      `Tools: pdf_text(pdf_id, pages) re-reads pages; pdf_pages(pdf_id, pages) renders pages as images for figures/tables.\n` +
      body;
    this.pdfCache.set(key, text);
    return text;
  }
}

import { copyFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { Attachment, Derivation } from '@shared/schemas';
import type { FfmpegService } from './ffmpeg';
import type { PdfService } from './pdf';
import type { MediaStore } from './store';

/**
 * 動画に対する派生物の生成。結果は添付として登録し(sha256 で重複排除)、
 * 同じパラメータの再要求はメモリ上のキーで再利用する。
 * 派生物にはその作り方(meta.derivation)を残し、ファイルをキャッシュとして消した後でも
 * regenerate() で元の添付から作り直せる(M23)。
 */

export interface ContactSheetOptions {
  startMs?: number;
  endMs?: number;
  cols?: number;
  rows?: number;
  tileWidth?: number;
}

export interface NativeClipOptions {
  maxSeconds: number;
  width: number;
  fps: number;
}

export const DEFAULT_NATIVE_CLIP: NativeClipOptions = { maxSeconds: 60, width: 640, fps: 2 };

export class VideoOps {
  private readonly derived = new Map<string, string>(); // key -> attachment id

  constructor(
    private readonly store: MediaStore,
    private readonly ffmpeg: FfmpegService,
    private readonly pdf?: PdfService,
  ) {}

  durationMs(video: Attachment): number {
    return video.meta.durationMs ?? 0;
  }

  private async cached(key: string, produce: () => Promise<Attachment>): Promise<Attachment> {
    const id = this.derived.get(key);
    if (id) {
      const a = this.store.get(id);
      // ファイルを消してあれば produce し直す(同じ内容なら addFile がレコードを再利用してファイルを戻す)
      if (a && !this.store.isEvicted(a)) return a;
    }
    const a = await produce();
    this.derived.set(key, a.id);
    return a;
  }

  async contactSheet(
    video: Attachment,
    opts: ContactSheetOptions = {},
    signal?: AbortSignal,
  ): Promise<{ sheet: Attachment; timestampsMs: number[] }> {
    const dur = this.durationMs(video);
    const startMs = clamp(opts.startMs ?? 0, 0, Math.max(0, dur - 1));
    const endMs = clamp(opts.endMs ?? dur, startMs + 1, Math.max(dur, startMs + 1));
    const cols = clamp(opts.cols ?? 4, 1, 8);
    const rows = clamp(opts.rows ?? 4, 1, 8);
    const tileWidth = clamp(opts.tileWidth ?? 256, 96, 640);
    const key = `sheet:${video.id}:${startMs}:${endMs}:${cols}x${rows}:${tileWidth}`;
    let timestampsMs: number[] = [];
    const sheet = await this.cached(key, async () => {
      const out = this.store.scratchPath('sheet.jpg');
      const r = await this.ffmpeg.contactSheet(
        this.store.pathOf(video),
        out,
        { startMs, endMs, cols, rows, tileWidth },
        signal,
      );
      timestampsMs = r.timestampsMs;
      return this.store.addFile(out, {
        originalName: `${video.originalName}.sheet.jpg`,
        mime: 'image/jpeg',
        derivedFrom: video.id,
        derivedLabel: `contact-sheet ${cols}x${rows} ${fmt(startMs)}-${fmt(endMs)}`,
        derivation: { kind: 'sheet', startMs, endMs, cols, rows, tileWidth },
      });
    });
    if (timestampsMs.length === 0) {
      const n = cols * rows;
      const step = (endMs - startMs) / n;
      timestampsMs = Array.from({ length: n }, (_, i) => Math.round(startMs + step * i + step / 2));
    }
    return { sheet, timestampsMs };
  }

  async frames(
    video: Attachment,
    timestampsMs: number[],
    width = 768,
    signal?: AbortSignal,
  ): Promise<Attachment[]> {
    const dur = this.durationMs(video);
    const out: Attachment[] = [];
    for (const raw of timestampsMs) {
      const t = clamp(Math.round(raw), 0, Math.max(0, dur - 1));
      const key = `frame:${video.id}:${t}:${width}`;
      out.push(
        await this.cached(key, async () => {
          const path = this.store.scratchPath(`frame-${t}.jpg`);
          await this.ffmpeg.extractFrame(this.store.pathOf(video), t, path, { width }, signal);
          return this.store.addFile(path, {
            originalName: `${video.originalName}@${fmt(t)}.jpg`,
            mime: 'image/jpeg',
            derivedFrom: video.id,
            derivedLabel: `frame @${fmt(t)}`,
            timestampMs: t,
            derivation: { kind: 'frame', timestampMs: t, width },
          });
        }),
      );
    }
    return out;
  }

  async scenes(
    video: Attachment,
    threshold = 0.3,
    max = 50,
    signal?: AbortSignal,
  ): Promise<number[]> {
    return this.ffmpeg.sceneChanges(this.store.pathOf(video), threshold, max, signal);
  }

  async clip(
    video: Attachment,
    startMs: number,
    endMs: number,
    width = 640,
    fps = 2,
    signal?: AbortSignal,
  ): Promise<Attachment> {
    const dur = this.durationMs(video);
    const s = clamp(startMs, 0, Math.max(0, dur - 1));
    const e = clamp(endMs, s + 1, Math.max(dur, s + 1));
    const key = `clip:${video.id}:${s}:${e}:${width}:${fps}`;
    return this.cached(key, async () => {
      const path = this.store.scratchPath('clip.mp4');
      await this.ffmpeg.clip(
        this.store.pathOf(video),
        path,
        { startMs: s, endMs: e, width, fps },
        signal,
      );
      return this.store.addFile(path, {
        originalName: `${video.originalName}.${fmt(s)}-${fmt(e)}.mp4`,
        mime: 'video/mp4',
        derivedFrom: video.id,
        derivedLabel: `clip ${fmt(s)}-${fmt(e)}`,
        derivation: { kind: 'clip', startMs: s, endMs: e, width, fps },
      });
    });
  }

  /** 音声入力用に、モノラル 16kHz mp3 に変換したもの(先頭 maxSeconds まで) */
  async nativeAudio(
    audio: Attachment,
    maxSeconds = 300,
    signal?: AbortSignal,
  ): Promise<Attachment> {
    const key = `audio:${audio.id}:${maxSeconds}`;
    return this.cached(key, async () => {
      const path = this.store.scratchPath('audio.mp3');
      await this.ffmpeg.transcodeAudio(this.store.pathOf(audio), path, { maxSeconds }, signal);
      return this.store.addFile(path, {
        originalName: `${audio.originalName}.16k.mp3`,
        mime: 'audio/mpeg',
        derivedFrom: audio.id,
        derivedLabel: `audio mono16k ${maxSeconds}s`,
        derivation: { kind: 'audio', maxSeconds },
      });
    });
  }

  /**
   * ネイティブ動画入力用に、縮小・低 fps 化したクリップ。区間指定があればその区間の先頭から、
   * なければ動画の先頭から、いずれも maxSeconds まで。
   */
  async nativeClip(
    video: Attachment,
    opts: NativeClipOptions = DEFAULT_NATIVE_CLIP,
    signal?: AbortSignal,
    range?: { startMs: number; endMs: number },
  ): Promise<Attachment> {
    const dur = this.durationMs(video);
    const startMs = clamp(range?.startMs ?? 0, 0, Math.max(0, dur - 1));
    const wanted = Math.min(range?.endMs ?? dur, dur);
    const endMs = Math.min(wanted, startMs + opts.maxSeconds * 1000);
    return this.clip(video, startMs, endMs, opts.width, opts.fps, signal);
  }

  /** 画像添付を長辺上限に縮小した派生画像(送信用) */
  async resizedImage(
    image: Attachment,
    maxEdge: number,
    signal?: AbortSignal,
  ): Promise<Attachment> {
    const w = image.meta.width ?? 0;
    const h = image.meta.height ?? 0;
    if (
      w &&
      h &&
      Math.max(w, h) <= maxEdge &&
      (image.mime === 'image/jpeg' || image.mime === 'image/png')
    )
      return image;
    const key = `resize:${image.id}:${maxEdge}`;
    return this.cached(key, async () => {
      const path = this.store.scratchPath('resized.jpg');
      await this.ffmpeg.resizeImage(this.store.pathOf(image), path, maxEdge, signal);
      return this.store.addFile(path, {
        originalName: `${image.originalName}.resized.jpg`,
        mime: 'image/jpeg',
        derivedFrom: image.id,
        derivedLabel: `resized ${maxEdge}px`,
        derivation: { kind: 'resize', maxEdge },
      });
    });
  }

  /**
   * キャッシュから消した派生物を、元の添付から同じ指定で作り直して元のパスに置く(M23)。
   * 元の添付が無い、作り方が分からない、変換に失敗した時は false。
   * sha256 はレコードのものを保ち(ffmpeg の出力は普通は同じバイト列になるが、違っても構わない)、サイズだけ更新する
   */
  async regenerate(a: Attachment, signal?: AbortSignal): Promise<boolean> {
    const d = derivationOf(a);
    if (!d || !a.meta.derivedFrom) return false;
    const src = this.store.get(a.meta.derivedFrom);
    if (!src || this.store.isEvicted(src)) return false;
    const srcPath = this.store.pathOf(src);
    const tmp = this.store.scratchPath(`regen-${a.id}.${a.ext}`);
    try {
      switch (d.kind) {
        case 'frame':
          await this.ffmpeg.extractFrame(srcPath, d.timestampMs, tmp, { width: d.width }, signal);
          break;
        case 'sheet':
          await this.ffmpeg.contactSheet(srcPath, tmp, d, signal);
          break;
        case 'clip':
          await this.ffmpeg.clip(srcPath, tmp, d, signal);
          break;
        case 'audio':
          await this.ffmpeg.transcodeAudio(srcPath, tmp, { maxSeconds: d.maxSeconds }, signal);
          break;
        case 'resize':
          await this.ffmpeg.resizeImage(srcPath, tmp, d.maxEdge, signal);
          break;
        case 'pdf-page': {
          if (!this.pdf) return false;
          const [page] = await this.pdf.renderPages(srcPath, [d.page], { width: d.width });
          if (!page) return false;
          writeFileSync(tmp, page.jpeg);
          break;
        }
      }
      const dest = this.store.pathOf(a);
      copyFileSync(tmp, dest);
      this.store.updateSize(a, statSync(dest).size);
      return true;
    } catch (e) {
      console.warn(`[media] regenerate failed for ${a.originalName}:`, (e as Error).message);
      return false;
    } finally {
      try {
        rmSync(tmp, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * 派生物の作り方。meta.derivation があればそれ、無い古い派生物はラベルとメタ情報から推定する
 * (フレーム: timestampMs と実際の幅、コンタクトシート: "contact-sheet 4x4 0.0s-95.0s"、クリップ: "clip 0.0s-60.0s")
 */
export function derivationOf(a: Attachment): Derivation | null {
  if (a.meta.derivation) return a.meta.derivation;
  const label = a.meta.derivedLabel ?? '';
  if (a.meta.timestampMs !== undefined && a.meta.width)
    return { kind: 'frame', timestampMs: a.meta.timestampMs, width: a.meta.width };
  let m = /^contact-sheet (\d+)x(\d+) ([\d.]+)s-([\d.]+)s$/.exec(label);
  if (m) {
    const cols = Number(m[1]);
    const rows = Number(m[2]);
    // タイル幅はシート全体の幅から逆算(作成時の既定は 256)
    const tileWidth = a.meta.width ? Math.round(a.meta.width / cols) : 256;
    return {
      kind: 'sheet',
      startMs: Math.round(Number(m[3]) * 1000),
      endMs: Math.round(Number(m[4]) * 1000),
      cols,
      rows,
      tileWidth,
    };
  }
  m = /^clip ([\d.]+)s-([\d.]+)s$/.exec(label);
  if (m && a.meta.width && a.meta.fps)
    return {
      kind: 'clip',
      startMs: Math.round(Number(m[1]) * 1000),
      endMs: Math.round(Number(m[2]) * 1000),
      width: a.meta.width,
      fps: Math.round(a.meta.fps * 100) / 100,
    };
  m = /^resized (\d+)px$/.exec(label);
  if (m) return { kind: 'resize', maxEdge: Number(m[1]) };
  m = /^audio mono16k (\d+)s$/.exec(label);
  if (m) return { kind: 'audio', maxSeconds: Number(m[1]) };
  m = /^page (\d+)$/.exec(label);
  if (m && a.meta.width) return { kind: 'pdf-page', page: Number(m[1]), width: a.meta.width };
  return null;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** ミリ秒を "12.5s" 形式にする */
export function fmt(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

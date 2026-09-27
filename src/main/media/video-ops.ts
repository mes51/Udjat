import type { Attachment } from '@shared/schemas';
import type { FfmpegService } from './ffmpeg';
import type { MediaStore } from './store';

/**
 * 動画に対する派生物の生成。結果は添付として登録し(sha256 で重複排除)、
 * 同じパラメータの再要求はメモリ上のキーで再利用する。
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
  ) {}

  durationMs(video: Attachment): number {
    return video.meta.durationMs ?? 0;
  }

  private async cached(key: string, produce: () => Promise<Attachment>): Promise<Attachment> {
    const id = this.derived.get(key);
    if (id) {
      const a = this.store.get(id);
      if (a) return a;
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
      });
    });
  }
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** ミリ秒を "12.5s" 形式にする */
export function fmt(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

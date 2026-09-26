import { execa, type Options as ExecaOptions } from 'execa';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveBinaries } from './binaries';

/**
 * ffmpeg / ffprobe の子プロセス呼び出し。設計は docs/plan/03-video-and-attachments.md。
 * すべて同期的に待つ(呼び出し側で並列度を制御する)。
 */

export interface ProbeResult {
  kind: 'video' | 'image' | 'audio' | 'unknown';
  durationMs: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasAudio: boolean;
  videoCodec: string | null;
  audioCodec: string | null;
  formatName: string | null;
  nbFrames: number | null;
}

export interface FfmpegServiceOptions {
  ffmpeg?: string | null;
  ffprobe?: string | null;
  /** 1 コマンドの上限時間(ミリ秒) */
  timeoutMs?: number;
  /** drawtext 用フォント。null なら OS 既定候補から探す */
  fontFile?: string | null;
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
  ) {
    super(message);
    this.name = 'FfmpegError';
  }
}

function parseFps(rate: string | undefined): number | null {
  if (!rate) return null;
  const [a, b] = rate.split('/').map(Number);
  if (!a || !Number.isFinite(a)) return null;
  if (b === undefined) return a;
  if (!b) return null;
  return a / b;
}

/** ffmpeg の filtergraph 内で使うパスをエスケープする(Windows のドライブレターのコロン等) */
export function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function defaultFontFile(): string | null {
  const candidates =
    process.platform === 'win32'
      ? ['C:/Windows/Fonts/consola.ttf', 'C:/Windows/Fonts/arial.ttf']
      : process.platform === 'darwin'
        ? ['/System/Library/Fonts/Menlo.ttc', '/System/Library/Fonts/Helvetica.ttc']
        : [
            '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
            '/usr/share/fonts/dejavu/DejaVuSans.ttf',
          ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

export class FfmpegService {
  private readonly bins: { ffmpeg: string; ffprobe: string };
  private readonly timeoutMs: number;
  private readonly fontFile: string | null;

  constructor(opts: FfmpegServiceOptions = {}) {
    this.bins = resolveBinaries({ ffmpeg: opts.ffmpeg ?? null, ffprobe: opts.ffprobe ?? null });
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.fontFile = opts.fontFile === undefined ? defaultFontFile() : opts.fontFile;
  }

  get binaries(): { ffmpeg: string; ffprobe: string } {
    return this.bins;
  }

  private async run(
    bin: 'ffmpeg' | 'ffprobe',
    args: string[],
    signal?: AbortSignal,
  ): Promise<{ stdout: string; stderr: string }> {
    const opts: ExecaOptions = {
      timeout: this.timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      reject: false,
      ...(signal ? { cancelSignal: signal } : {}),
    };
    const res = await execa(this.bins[bin], args, opts);
    const stdout = String(res.stdout ?? '');
    const stderr = String(res.stderr ?? '');
    if (res.failed || res.exitCode !== 0) {
      if (signal?.aborted) throw signal.reason ?? new Error('aborted');
      const tail = stderr.trim().split('\n').slice(-6).join('\n');
      throw new FfmpegError(`${bin} failed (exit ${res.exitCode ?? '?'}): ${tail}`, stderr);
    }
    return { stdout, stderr };
  }

  async probe(file: string, signal?: AbortSignal): Promise<ProbeResult> {
    const { stdout } = await this.run(
      'ffprobe',
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      signal,
    );
    const data = JSON.parse(stdout) as {
      format?: { duration?: string; format_name?: string };
      streams?: {
        codec_type?: string;
        codec_name?: string;
        width?: number;
        height?: number;
        avg_frame_rate?: string;
        r_frame_rate?: string;
        duration?: string;
        nb_frames?: string;
        disposition?: { attached_pic?: number };
      }[];
    };
    const streams = data.streams ?? [];
    const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
    const audio = streams.find((s) => s.codec_type === 'audio');
    const durationSec = Number(data.format?.duration ?? video?.duration ?? audio?.duration ?? NaN);
    const durationMs = Number.isFinite(durationSec) ? Math.round(durationSec * 1000) : null;
    const formatName = data.format?.format_name ?? null;
    const fps = parseFps(video?.avg_frame_rate) ?? parseFps(video?.r_frame_rate);
    const nbFrames = video?.nb_frames ? Number(video.nb_frames) : null;

    let kind: ProbeResult['kind'] = 'unknown';
    const imageFormats = /image2|png_pipe|jpeg_pipe|webp_pipe|gif|bmp_pipe|tiff_pipe/;
    if (
      video &&
      (imageFormats.test(formatName ?? '') ||
        (durationMs === null && !audio) ||
        (nbFrames === 1 && formatName !== 'mov,mp4,m4a,3gp,3g2,mj2'))
    ) {
      kind = 'image';
    } else if (video) kind = 'video';
    else if (audio) kind = 'audio';

    return {
      kind,
      durationMs: kind === 'image' ? null : durationMs,
      width: video?.width ?? null,
      height: video?.height ?? null,
      fps: kind === 'video' ? fps : null,
      hasAudio: !!audio,
      videoCodec: video?.codec_name ?? null,
      audioCodec: audio?.codec_name ?? null,
      formatName,
      nbFrames: Number.isFinite(nbFrames ?? NaN) ? nbFrames : null,
    };
  }

  /** 指定時刻のフレームを JPEG として書き出す */
  async extractFrame(
    file: string,
    timeMs: number,
    out: string,
    opts: { width?: number; quality?: number } = {},
    signal?: AbortSignal,
  ): Promise<void> {
    mkdirSync(dirname(out), { recursive: true });
    const width = opts.width ?? 768;
    await this.run(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-ss',
        (timeMs / 1000).toFixed(3),
        '-i',
        file,
        '-frames:v',
        '1',
        '-vf',
        `scale='min(${width},iw)':-2`,
        '-q:v',
        String(opts.quality ?? 3),
        out,
      ],
      signal,
    );
  }

  /** 画像を長辺上限に縮小して JPEG 化する(EXIF の回転も適用) */
  async resizeImage(
    file: string,
    out: string,
    maxEdge: number,
    signal?: AbortSignal,
  ): Promise<void> {
    mkdirSync(dirname(out), { recursive: true });
    await this.run(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        file,
        '-vf',
        `scale='if(gt(iw,ih),min(${maxEdge},iw),-2)':'if(gt(iw,ih),-2,min(${maxEdge},ih))'`,
        '-frames:v',
        '1',
        '-q:v',
        '3',
        out,
      ],
      signal,
    );
  }

  /** シーン切替の時刻(ミリ秒)を検出する */
  async sceneChanges(
    file: string,
    threshold = 0.3,
    max = 50,
    signal?: AbortSignal,
  ): Promise<number[]> {
    const { stderr } = await this.run(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'info',
        '-i',
        file,
        '-vf',
        `select='gt(scene,${threshold})',showinfo`,
        '-an',
        '-f',
        'null',
        '-',
      ],
      signal,
    );
    const times: number[] = [];
    for (const m of stderr.matchAll(/pts_time:\s*([\d.]+)/g)) {
      const t = Math.round(Number(m[1]) * 1000);
      if (Number.isFinite(t)) times.push(t);
      if (times.length >= max) break;
    }
    return times;
  }

  /**
   * 区間を等間隔サンプリングしてタイル画像にする。各タイルに時刻を焼き込む。
   * 返り値は各タイルの時刻(ミリ秒)。
   */
  async contactSheet(
    file: string,
    out: string,
    opts: { startMs: number; endMs: number; cols: number; rows: number; tileWidth: number },
    signal?: AbortSignal,
  ): Promise<{ timestampsMs: number[] }> {
    mkdirSync(dirname(out), { recursive: true });
    const n = opts.cols * opts.rows;
    const span = Math.max(1, opts.endMs - opts.startMs);
    // 区間を n 等分し、各区間の中央付近を拾う
    const step = span / n;
    const timestampsMs = Array.from({ length: n }, (_, i) =>
      Math.round(opts.startMs + step * i + step / 2),
    );
    const fps = n / (span / 1000);
    const text = this.fontFile
      ? `,drawtext=fontfile='${escapeFilterPath(this.fontFile)}':text='%{pts\\:hms}':x=6:y=6:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=4`
      : '';
    const vf = `fps=${fps.toFixed(6)}:start_time=${(opts.startMs / 1000).toFixed(3)},scale=${opts.tileWidth}:-2${text},tile=${opts.cols}x${opts.rows}:padding=2:margin=2:color=black`;
    await this.run(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-ss',
        (opts.startMs / 1000).toFixed(3),
        '-to',
        (opts.endMs / 1000).toFixed(3),
        '-copyts',
        '-i',
        file,
        '-vf',
        vf,
        '-frames:v',
        '1',
        '-q:v',
        '4',
        out,
      ],
      signal,
    );
    return { timestampsMs };
  }

  /** 区間を切り出して縮小・低 fps・無音の mp4 にする(ネイティブ動画入力用) */
  async clip(
    file: string,
    out: string,
    opts: { startMs: number; endMs: number; width: number; fps: number },
    signal?: AbortSignal,
  ): Promise<void> {
    mkdirSync(dirname(out), { recursive: true });
    await this.run(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-ss',
        (opts.startMs / 1000).toFixed(3),
        '-to',
        (opts.endMs / 1000).toFixed(3),
        '-i',
        file,
        '-vf',
        `fps=${opts.fps},scale='min(${opts.width},iw)':-2`,
        '-an',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '28',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        out,
      ],
      signal,
    );
  }
}

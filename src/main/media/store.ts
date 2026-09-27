import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { Attachment, AttachmentMeta } from '@shared/schemas';
import type { AttachmentRepository } from '@main/db/repositories/attachments';
import type { FfmpegService } from './ffmpeg';
import type { PdfService } from './pdf';

/**
 * 添付ファイルの保管庫。内容の sha256 で重複排除し、media/<sha>.<ext> に置く。
 * 派生物(フレーム、コンタクトシート、縮小版)も同じ仕組みで添付として登録する。
 * 設計は docs/plan/03-video-and-attachments.md。
 */

const MIME_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-matroska': 'mkv',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
  'audio/ogg': 'ogg',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
};

const EXT_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_EXT).map(([m, e]) => [e, m]),
);
EXT_MIME['jpeg'] = 'image/jpeg';
EXT_MIME['m4v'] = 'video/mp4';
EXT_MIME['md'] = 'text/markdown';

export function mimeFromName(name: string, fallback = 'application/octet-stream'): string {
  const ext = extname(name).slice(1).toLowerCase();
  return EXT_MIME[ext] ?? fallback;
}

export function kindFromMime(mime: string): AttachmentMeta['kind'] {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'file';
}

export interface MediaStoreOptions {
  mediaDir: string;
  cacheDir: string;
}

export class MediaStore {
  constructor(
    private readonly repo: AttachmentRepository,
    private readonly ffmpeg: FfmpegService,
    private readonly dirs: MediaStoreOptions,
    private readonly pdf?: PdfService,
  ) {
    mkdirSync(dirs.mediaDir, { recursive: true });
    mkdirSync(dirs.cacheDir, { recursive: true });
  }

  /**
   * 掃除: どのメッセージからも参照されていない添付のうち古いものと、DB に無い media/ 内のファイル、
   * scratch の残骸を消す。起動時に呼ぶ。
   */
  gc(opts: { maxAgeMs?: number; now?: number } = {}): {
    deletedAttachments: number;
    deletedFiles: number;
  } {
    const now = opts.now ?? Date.now();
    const maxAge = opts.maxAgeMs ?? 24 * 60 * 60 * 1000;
    let deletedAttachments = 0;
    let deletedFiles = 0;
    for (const a of this.repo.listUnreferenced()) {
      if (now - a.createdAt < maxAge) continue;
      this.repo.delete(a.id);
      deletedAttachments++;
      // 同じ内容(sha256)の別レコードは無いので、ファイルも消して良い
      try {
        rmSync(this.pathOf(a), { force: true });
      } catch {
        /* ignore */
      }
    }
    const known = new Set(this.repo.listAll().map((a) => `${a.sha256}.${a.ext}`));
    for (const name of readdirSync(this.dirs.mediaDir)) {
      if (known.has(name)) continue;
      try {
        rmSync(join(this.dirs.mediaDir, name), { force: true });
        deletedFiles++;
      } catch {
        /* ignore */
      }
    }
    const scratch = join(this.dirs.cacheDir, 'scratch');
    if (existsSync(scratch)) {
      for (const name of readdirSync(scratch)) {
        const p = join(scratch, name);
        try {
          if (now - statSync(p).mtimeMs > 60 * 60 * 1000) {
            rmSync(p, { force: true });
            deletedFiles++;
          }
        } catch {
          /* ignore */
        }
      }
    }
    return { deletedAttachments, deletedFiles };
  }

  pathOf(a: Attachment): string {
    return join(this.dirs.mediaDir, `${a.sha256}.${a.ext}`);
  }

  get(id: string): Attachment | null {
    return this.repo.get(id);
  }

  require(id: string): Attachment {
    const a = this.repo.get(id);
    if (!a) throw new Error(`添付が見つかりません: ${id}`);
    return a;
  }

  /** 作業用の一時パス(cache 配下)。ffmpeg の出力先に使い、その後 addFile で取り込む */
  scratchPath(name: string): string {
    const dir = join(this.dirs.cacheDir, 'scratch');
    mkdirSync(dir, { recursive: true });
    return join(
      dir,
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}-${name}`,
    );
  }

  /** バイト列から登録する(貼り付け画像や renderer で縮小した画像) */
  async addBytes(
    bytes: Buffer,
    originalName: string,
    mime: string,
    extraMeta: Partial<AttachmentMeta> = {},
  ): Promise<Attachment> {
    const tmp = this.scratchPath(originalName || 'blob');
    writeFileSync(tmp, bytes);
    return this.addFile(tmp, { originalName, mime, ...extraMeta });
  }

  /** ファイルパスから登録する(元ファイルはコピーし、cache 配下なら消す) */
  async addFile(
    path: string,
    opts: { originalName?: string; mime?: string } & Partial<AttachmentMeta> = {},
  ): Promise<Attachment> {
    if (!existsSync(path)) throw new Error(`ファイルが見つかりません: ${path}`);
    const originalName = opts.originalName ?? basename(path);
    const mime = opts.mime ?? mimeFromName(originalName, mimeFromName(path));
    const sha256 = hashFile(path);
    const existing = this.repo.getBySha(sha256);
    if (existing) {
      this.cleanupScratch(path);
      return existing;
    }
    const ext = MIME_EXT[mime] ?? extname(originalName).slice(1).toLowerCase() ?? 'bin';
    const dest = join(this.dirs.mediaDir, `${sha256}.${ext}`);
    if (!existsSync(dest)) copyFileSync(path, dest);
    this.cleanupScratch(path);

    const { originalName: _n, mime: _m, ...extra } = opts;
    const meta = await this.buildMeta(dest, mime, extra);
    return this.repo.create({ sha256, mime, ext, originalName, size: statSync(dest).size, meta });
  }

  readBase64(a: Attachment): string {
    return readFileSync(this.pathOf(a)).toString('base64');
  }

  private cleanupScratch(path: string): void {
    if (path.startsWith(join(this.dirs.cacheDir, 'scratch'))) {
      try {
        rmSync(path, { force: true });
      } catch {
        /* ignore */
      }
    }
  }

  private async buildMeta(
    path: string,
    mime: string,
    extra: Partial<AttachmentMeta>,
  ): Promise<AttachmentMeta> {
    const kind = kindFromMime(mime);
    const meta: AttachmentMeta = { kind, ...extra };
    if (kind === 'image' || kind === 'video' || kind === 'audio') {
      try {
        const p = await this.ffmpeg.probe(path);
        if (p.width) meta.width = p.width;
        if (p.height) meta.height = p.height;
        if (p.durationMs !== null) meta.durationMs = p.durationMs;
        if (p.fps !== null) meta.fps = p.fps;
        meta.hasAudio = p.hasAudio;
        if (p.videoCodec) meta.codec = p.videoCodec;
        else if (p.audioCodec) meta.codec = p.audioCodec;
      } catch (e) {
        meta.probeError = (e as Error).message.slice(0, 300);
      }
    }
    if (mime === 'application/pdf' && this.pdf) {
      try {
        const info = await this.pdf.info(path);
        meta.pageCount = info.numPages;
        if (info.title) meta.title = info.title;
      } catch (e) {
        meta.probeError = (e as Error).message.slice(0, 300);
      }
    }
    return meta;
  }
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

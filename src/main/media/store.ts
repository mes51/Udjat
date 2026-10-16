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

  /** 会話に付いている添付(run_javascript の udjat.attachments() 用) */
  listForConversation(conversationId: string): Attachment[] {
    return this.repo.listForConversation(conversationId);
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
      // 同じ内容のレコードがある。キャッシュとしてファイルだけ消してあれば(M23)この機会に戻す
      const dest = this.pathOf(existing);
      if (!existsSync(dest)) copyFileSync(path, dest);
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

  /** 内容を base64 で読む。キャッシュから消した派生物なら先に作り直す(M23) */
  async readBase64(a: Attachment): Promise<string> {
    return readFileSync(await this.ensureFile(a)).toString('base64');
  }

  // ---- 派生物のキャッシュ(M23) ----
  // フレーム・コンタクトシート・クリップ等の派生物は、レコード(メッセージからの参照とメタ情報)を残したまま
  // ファイルだけを消せる。必要になった時は restorer(VideoOps.regenerate)が元の添付から作り直す。

  private restorer: ((a: Attachment) => Promise<boolean>) | null = null;
  private readonly restoring = new Map<string, Promise<string>>();

  /** ファイルが無い派生物を作り直す関数を登録する。true を返せば pathOf(a) にファイルがある */
  setRestorer(fn: (a: Attachment) => Promise<boolean>): void {
    this.restorer = fn;
  }

  /** 派生物か(キャッシュとして消して良いもの) */
  isDerived(a: Attachment): boolean {
    return a.meta.derivedFrom !== undefined;
  }

  /** ファイルが消えているか */
  isEvicted(a: Attachment): boolean {
    return !existsSync(this.pathOf(a));
  }

  /**
   * ファイルのパスを返す。消してあれば作り直してから返す(同じ添付の同時要求は 1 回にまとめる)。
   * 作り直せなければ例外
   */
  async ensureFile(a: Attachment): Promise<string> {
    const path = this.pathOf(a);
    if (existsSync(path)) return path;
    const inflight = this.restoring.get(a.id);
    if (inflight) return inflight;
    const p = (async () => {
      const restored = this.restorer ? await this.restorer(a) : false;
      if (!restored || !existsSync(path)) {
        throw new Error(
          this.isDerived(a)
            ? `${a.originalName} はキャッシュから削除されていて、元の添付からも作り直せませんでした`
            : `添付ファイルが見つかりません: ${a.originalName}`,
        );
      }
      return path;
    })();
    this.restoring.set(a.id, p);
    try {
      return await p;
    } finally {
      this.restoring.delete(a.id);
    }
  }

  /** 作り直した派生物のサイズを反映する */
  updateSize(a: Attachment, size: number): void {
    this.repo.updateSize(a.id, size);
  }

  /** 派生物のファイルを消す(レコードは残す)。消したバイト数を返す(既に無ければ 0) */
  evict(a: Attachment): number {
    if (!this.isDerived(a)) return 0;
    const path = this.pathOf(a);
    let size = 0;
    try {
      size = statSync(path).size;
      rmSync(path, { force: true });
    } catch {
      return 0;
    }
    return size;
  }

  /** 派生物のキャッシュ状況。conversationId を指定すればその会話に付いているものだけ */
  derivedStats(conversationId?: string): { count: number; bytes: number; evicted: number } {
    let count = 0;
    let bytes = 0;
    let evicted = 0;
    for (const a of this.repo.listDerived(conversationId)) {
      count++;
      try {
        bytes += statSync(this.pathOf(a)).size;
      } catch {
        evicted++;
      }
    }
    return { count, bytes, evicted };
  }

  /** 派生物のファイルをまとめて消す(会話を指定しなければ全部)。消した件数とバイト数を返す */
  evictDerived(conversationId?: string): { count: number; bytes: number } {
    let count = 0;
    let bytes = 0;
    for (const a of this.repo.listDerived(conversationId)) {
      const n = this.evict(a);
      if (n > 0) {
        count++;
        bytes += n;
      }
    }
    return { count, bytes };
  }

  /**
   * 派生物の合計が上限を超えていたら、古いものから消して上限内に収める。
   * 直近 1 時間に作ったものは(今まさに使っている可能性が高いので)残す
   */
  enforceDerivedLimit(maxBytes: number, now = Date.now()): { count: number; bytes: number } {
    const out = { count: 0, bytes: 0 };
    if (!(maxBytes > 0)) return out;
    const present: { a: Attachment; size: number }[] = [];
    let total = 0;
    for (const a of this.repo.listDerived()) {
      try {
        const size = statSync(this.pathOf(a)).size;
        present.push({ a, size });
        total += size;
      } catch {
        /* 既に消えている */
      }
    }
    if (total <= maxBytes) return out;
    present.sort((x, y) => x.a.createdAt - y.a.createdAt);
    for (const { a, size } of present) {
      if (total <= maxBytes) break;
      if (now - a.createdAt < 60 * 60 * 1000) continue;
      if (this.evict(a) > 0) {
        total -= size;
        out.count++;
        out.bytes += size;
      }
    }
    return out;
  }

  /** どのメッセージからも参照されなくなった派生物をレコードごと消す(会話の削除直後に呼ぶ) */
  gcUnreferencedDerived(): number {
    let n = 0;
    for (const a of this.repo.listUnreferenced()) {
      if (!this.isDerived(a)) continue;
      this.repo.delete(a.id);
      try {
        rmSync(this.pathOf(a), { force: true });
      } catch {
        /* ignore */
      }
      n++;
    }
    return n;
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

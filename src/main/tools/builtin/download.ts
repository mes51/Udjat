import { createWriteStream, promises as fs } from 'node:fs';
import { basename, extname, isAbsolute } from 'node:path';
import type { Attachment } from '@shared/schemas';
import { kindFromMime, mimeFromName, type MediaStore } from '@main/media/store';
import type { RegisteredTool, ToolMedia } from '../types';
import { fail, num, ok, str } from '../types';
import { checkPath, readRoots } from './files';
import { checkUrl } from './net-guard';

/**
 * バイナリのダウンロード(M18)。URL の内容を添付ストアに取り込み、画像ならモデルに見せる。
 * web_download ツールと、run_javascript の udjat.download の両方がこのヘルパーを使う。
 * 設計は docs/plan/11-binary-download.md。
 */

export const DEFAULT_DOWNLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;
const USER_AGENT = 'Udjat/0.1 (+local LLM chat client)';
const BINARY_EXT_FROM_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'application/pdf': 'pdf',
  'application/json': 'json',
  'text/plain': 'txt',
  'application/zip': 'zip',
};

export interface DownloadOptions {
  maxBytes: number;
  signal: AbortSignal;
  /** SSRF ガードで許可するプライベートホスト(web_fetch と同じ設定) */
  allowHosts?: string[];
  /** 呼び出し側で既にホストを検査済みなら true(run_javascript の allow_net) */
  skipGuard?: boolean;
  /** 保存名(省略時は Content-Disposition か URL の末尾) */
  name?: string;
  timeoutMs?: number;
}

export interface Downloaded {
  attachment: Attachment;
  finalUrl: string;
  contentType: string;
}

function nameFromResponse(res: Response, url: URL, mime: string, override?: string): string {
  let name = override?.trim() || '';
  if (!name) {
    const cd = res.headers.get('content-disposition') ?? '';
    const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(cd);
    const plain = /filename="?([^";]+)"?/i.exec(cd);
    const raw = star?.[1] ?? plain?.[1] ?? '';
    try {
      name = raw ? decodeURIComponent(raw.trim()) : '';
    } catch {
      name = raw.trim();
    }
  }
  if (!name) name = basename(decodeURIComponent(url.pathname)) || 'download';
  name = name.replace(/[\\/:*?"<>|]/g, '_');
  if (!extname(name)) {
    const ext =
      BINARY_EXT_FROM_MIME[mime] ?? (mime.split('/')[1] ?? 'bin').replace(/[^a-z0-9]/gi, '');
    name = `${name}.${ext || 'bin'}`;
  }
  return name;
}

/** URL の内容を上限付きで取得し、添付ストアに登録する */
export async function downloadToStore(
  store: MediaStore,
  rawUrl: string,
  opts: DownloadOptions,
): Promise<Downloaded> {
  let url: URL;
  if (opts.skipGuard) {
    url = new URL(rawUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:')
      throw new Error(`http / https 以外は取得できません (${url.protocol})`);
  } else {
    const check = await checkUrl(rawUrl, opts.allowHosts ? { allowHosts: opts.allowHosts } : {});
    if (!check.ok) throw new Error(check.reason);
    url = check.url;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), opts.timeoutMs ?? 120_000);
  const onAbort = () => controller.abort(opts.signal.reason);
  opts.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: '*/*' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const declared = Number(res.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > opts.maxBytes)
      throw new Error(`サイズ上限を超えています (${declared} バイト、上限 ${opts.maxBytes})`);
    const ctype = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    let mime = ctype && ctype !== 'application/octet-stream' ? ctype : '';
    const name = nameFromResponse(res, url, mime || 'application/octet-stream', opts.name);
    if (!mime) mime = mimeFromName(name);

    const tmp = store.scratchPath(name);
    const out = createWriteStream(tmp);
    let total = 0;
    try {
      if (!res.body) throw new Error('本文がありません');
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > opts.maxBytes) {
          await reader.cancel();
          throw new Error(`サイズ上限を超えています (${opts.maxBytes} バイト)`);
        }
        if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
      }
      await new Promise<void>((resolve, reject) => {
        out.end();
        out.once('finish', () => resolve());
        out.once('error', reject);
      });
    } catch (e) {
      out.destroy();
      await fs.rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
    const attachment = await store.addFile(tmp, { originalName: name, mime });
    return { attachment, finalUrl: res.url || url.href, contentType: ctype };
  } finally {
    clearTimeout(timer);
    opts.signal.removeEventListener('abort', onAbort);
  }
}

/** ダウンロード結果をモデル向けの JSON と media にする(画像は見せる、動画 / PDF は id を返す) */
export function describeDownloaded(d: Downloaded, extra: Record<string, unknown> = {}) {
  const a = d.attachment;
  const kind = kindFromMime(a.mime);
  const body: Record<string, unknown> = {
    url: d.finalUrl,
    attachment_id: a.id,
    name: a.originalName,
    mime: a.mime,
    size: a.size,
    kind,
    ...extra,
  };
  const media: ToolMedia[] = [];
  if (kind === 'image') {
    body['image_id'] = a.id;
    if (a.meta.width) {
      body['width'] = a.meta.width;
      body['height'] = a.meta.height;
    }
    body['note'] = 'この画像はモデルに渡されます';
    media.push({ attachmentId: a.id, mime: a.mime, kind: 'image', label: a.originalName });
  } else if (kind === 'video') {
    body['video_id'] = a.id;
    body['duration_ms'] = a.meta.durationMs ?? null;
    body['note'] = '動画ツール(video_info / video_frames など)で中身を見られます';
  } else if (a.mime === 'application/pdf') {
    body['pdf_id'] = a.id;
    body['num_pages'] = a.meta.pageCount ?? null;
    body['note'] = 'pdf_text / pdf_pages で中身を読めます';
  } else if (kind === 'audio') {
    body['audio_id'] = a.id;
  } else {
    body['note'] =
      'テキストなら attachment_text(attachment_id) で読めます。バイナリは run_javascript の udjat.readAttachment(id, "buffer") で扱えます';
  }
  return { body, media };
}

export interface DownloadToolDeps {
  store: MediaStore;
}

export function createDownloadTools({ store }: DownloadToolDeps): RegisteredTool[] {
  const webDownload: RegisteredTool = {
    definition: {
      name: 'web_download',
      description:
        'URL からファイル(画像・動画・PDF・その他のバイナリ)をダウンロードして会話の添付として取り込む。画像はそのままモデルに見える。' +
        '生成結果の画像を確認する、API が返したファイルを受け取る時に使う。テキストや HTML を読むだけなら web_fetch。' +
        `既定の上限は ${DEFAULT_DOWNLOAD_BYTES} バイト。それより大きいファイルや、save_to でフォルダに保存する場合は承認が必要。`,
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'ダウンロードする URL (http / https)' },
          max_bytes: {
            type: 'integer',
            description: `受け取る最大バイト数(既定 ${DEFAULT_DOWNLOAD_BYTES}、上限 ${MAX_DOWNLOAD_BYTES}。既定より大きい値は承認が必要)`,
            minimum: 1,
            maximum: MAX_DOWNLOAD_BYTES,
          },
          name: { type: 'string', description: '保存名(省略時はサーバーの指定か URL の末尾)' },
          save_to: {
            type: 'string',
            description:
              '添付に加えてこの絶対パスにも保存する(書き込み可の許可フォルダ配下のみ。承認が必要)',
          },
        },
        required: ['url'],
        additionalProperties: false,
      },
    },
    source: { kind: 'builtin' },
    category: 'web',
    defaultPolicy: 'auto',
    // 大きい上限やフォルダへの保存は、ポリシーや会話単位の常時許可に関わらず確認する
    requiresApproval: (args) =>
      (typeof args['max_bytes'] === 'number' && args['max_bytes'] > DEFAULT_DOWNLOAD_BYTES) ||
      (typeof args['save_to'] === 'string' && args['save_to'].trim() !== ''),
    execute: async (args, ctx) => {
      const url = str(args, 'url');
      const maxBytes = Math.floor(
        num(args, 'max_bytes', DEFAULT_DOWNLOAD_BYTES, 1, MAX_DOWNLOAD_BYTES),
      );
      const name = typeof args['name'] === 'string' ? args['name'] : undefined;
      const saveTo = typeof args['save_to'] === 'string' ? args['save_to'].trim() : '';
      const allow = ctx.getSetting('webFetch.allowHosts');
      const allowHosts = Array.isArray(allow)
        ? allow.filter((x): x is string => typeof x === 'string')
        : [];
      let savedTo: string | undefined;
      if (saveTo) {
        if (!isAbsolute(saveTo)) return fail(`save_to は絶対パスで指定してください: ${saveTo}`);
        savedTo = await checkPath(saveTo, readRoots(ctx.getSetting), 'write');
      }
      let d: Downloaded;
      try {
        d = await downloadToStore(store, url, {
          maxBytes,
          signal: ctx.signal,
          allowHosts,
          ...(name ? { name } : {}),
        });
      } catch (e) {
        if (ctx.signal.aborted) throw e;
        return fail(`ダウンロードに失敗しました: ${(e as Error).message}`);
      }
      if (savedTo) {
        await fs.mkdir(savedTo.replace(/[\\/][^\\/]*$/, ''), { recursive: true });
        await fs.copyFile(store.pathOf(d.attachment), savedTo);
      }
      const { body, media } = describeDownloaded(d, savedTo ? { saved_to: savedTo } : {});
      return ok(JSON.stringify(body), media);
    },
  };
  return [webDownload];
}

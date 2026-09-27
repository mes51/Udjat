import { promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { FsRoot } from '@shared/schemas';
import type { PdfService } from '@main/media/pdf';
import { kindFromMime, mimeFromName, type MediaStore } from '@main/media/store';
import { looksText } from '@main/media/text-files';
import type { RegisteredTool, ToolMedia } from '../types';
import { fail, num, ok, str, ToolError } from '../types';
import { pathAllowed } from './code';

/**
 * ファイルアクセスツール(M12): fs_list / fs_read / fs_write。
 * 設定 fs.roots に登録した許可フォルダの配下だけを扱う。設計は docs/plan/08-file-tools.md。
 */

export interface FileToolDeps {
  store: MediaStore;
  pdf?: PdfService;
  getSetting: (key: string) => unknown;
}

const DEFAULT_MAX_CHARS = 20_000;
const MAX_CHARS = 200_000;
const MAX_BINARY_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_BYTES = 32 * 1024 * 1024;
const MAX_DEPTH = 6;
const DEFAULT_MAX_ENTRIES = 200;
const MAX_ENTRIES = 1000;

/** 設定から許可フォルダを読む(壊れた項目は無視) */
export function readRoots(getSetting: (key: string) => unknown): FsRoot[] {
  const v = getSetting('fs.roots');
  if (!Array.isArray(v)) return [];
  return v
    .filter(
      (r): r is { path: string; write?: unknown } =>
        !!r && typeof r === 'object' && typeof (r as { path?: unknown }).path === 'string',
    )
    .map((r) => ({ path: r.path.trim(), write: r.write === true }))
    .filter((r) => r.path !== '' && isAbsolute(r.path));
}

/** 実在する最も近い祖先(自身を含む)を realpath に解き、残りを付け直す */
async function realish(path: string): Promise<string> {
  let cur = resolve(path);
  const rest: string[] = [];
  for (;;) {
    try {
      const real = await fs.realpath(cur);
      return rest.length === 0 ? real : resolve(real, ...rest.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(path);
      rest.push(basename(cur));
      cur = parent;
    }
  }
}

/** パスが許可フォルダ配下か(書き込みなら write: true のフォルダだけ)を検査し、正規化したパスを返す */
export async function checkPath(
  path: string,
  roots: FsRoot[],
  mode: 'read' | 'write',
): Promise<string> {
  if (!isAbsolute(path)) throw new ToolError(`パスは絶対パスで指定してください: ${path}`);
  const usable = mode === 'write' ? roots.filter((r) => r.write) : roots;
  const allowed = usable.map((r) => r.path);
  const resolved = resolve(path);
  const real = await realish(resolved);
  if (pathAllowed(resolved, allowed) && pathAllowed(real, allowed)) return real;
  const list = usable.map((r) => r.path).join(', ') || '(なし)';
  throw new ToolError(
    mode === 'write'
      ? `書き込みが許可されていないパスです: ${path}。書き込み可の許可フォルダ: ${list}。必要なら「設定 > ツール > ファイル」で許可フォルダを追加するようユーザーに依頼してください`
      : `許可されていないパスです: ${path}。許可フォルダ: ${list}。必要なら「設定 > ツール > ファイル」で許可フォルダを追加するようユーザーに依頼してください`,
  );
}

/** glob(* / ? / **)を正規表現にする。区切りは / に正規化して比較する */
export function globToRegExp(pattern: string): RegExp {
  let re = '';
  const p = pattern.replace(/\\/g, '/');
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === '*') {
      if (p[i + 1] === '*') {
        i++;
        if (p[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, process.platform === 'win32' ? 'i' : '');
}

interface ListEntry {
  path: string;
  type: 'file' | 'dir' | 'other';
  size: number;
  modified: string;
}

async function walk(
  root: string,
  opts: { recursive: boolean; matcher: RegExp | null; signal: AbortSignal },
): Promise<ListEntry[]> {
  const out: ListEntry[] = [];
  const visit = async (dir: string, depth: number) => {
    if (opts.signal.aborted) throw new Error('aborted');
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (depth === 0) throw e;
      return;
    }
    for (const e of entries) {
      const full = resolve(dir, e.name);
      const rel = relative(root, full).split(sep).join('/');
      const type = e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other';
      if (!opts.matcher || opts.matcher.test(rel)) {
        let size = 0;
        let modified = '';
        try {
          const st = await fs.stat(full);
          size = st.size;
          modified = st.mtime.toISOString();
        } catch {
          /* 消えた・権限なし */
        }
        out.push({ path: rel, type, size, modified });
      }
      if (type === 'dir' && opts.recursive && depth < MAX_DEPTH && !e.isSymbolicLink())
        await visit(full, depth + 1);
    }
  };
  await visit(root, 0);
  return out;
}

export function createFileTools({ store, pdf, getSetting }: FileToolDeps): RegisteredTool[] {
  const roots = () => readRoots(getSetting);
  const unavailable = () =>
    roots().length === 0
      ? '許可フォルダが未設定です(設定 > ツール > ファイル で追加すると使えます)'
      : null;
  const rootsHint = () => {
    const r = roots();
    return r.length === 0
      ? ''
      : ` 許可フォルダ: ${r.map((x) => `${x.path}${x.write ? ' (書込可)' : ''}`).join(', ')}。`;
  };

  const list: RegisteredTool = {
    definition: {
      name: 'fs_list',
      description:
        'フォルダの中身を一覧する(許可フォルダ配下のみ)。生成されたファイルを探す、最新のファイルを見つける時に使う。' +
        'pattern で glob(*.png / **/*.json)、sort=mtime + newest_first で新しい順。結果は相対パスで返る。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '一覧するフォルダの絶対パス' },
          recursive: {
            type: 'boolean',
            description: 'サブフォルダも辿る(既定 false、深さ 6 まで)',
          },
          pattern: {
            type: 'string',
            description: '名前の glob。* ? ** が使える(例: "*.png", "**/*.json")',
          },
          sort: {
            type: 'string',
            enum: ['name', 'mtime', 'size'],
            description: '並び順(既定 name)',
          },
          newest_first: { type: 'boolean', description: 'mtime / size を降順にする' },
          max_entries: {
            type: 'integer',
            description: `返す件数の上限(既定 ${DEFAULT_MAX_ENTRIES}、上限 ${MAX_ENTRIES})`,
            minimum: 1,
            maximum: MAX_ENTRIES,
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
    source: { kind: 'builtin' },
    category: 'files',
    defaultPolicy: 'auto',
    unavailable,
    execute: async (args, ctx) => {
      const path = await checkPath(str(args, 'path'), roots(), 'read');
      const st = await fs.stat(path).catch(() => null);
      if (!st) return fail(`フォルダが見つかりません: ${path}`);
      if (!st.isDirectory()) return fail(`フォルダではありません: ${path}`);
      const recursive = args['recursive'] === true;
      const pattern =
        typeof args['pattern'] === 'string' && args['pattern'].trim() !== ''
          ? args['pattern'].trim()
          : null;
      const matcher = pattern ? globToRegExp(pattern) : null;
      const sort = args['sort'] === 'mtime' || args['sort'] === 'size' ? args['sort'] : 'name';
      const desc = args['newest_first'] === true;
      const max = Math.floor(num(args, 'max_entries', DEFAULT_MAX_ENTRIES, 1, MAX_ENTRIES));
      const entries = await walk(path, { recursive, matcher, signal: ctx.signal });
      entries.sort((a, b) => {
        const c =
          sort === 'mtime'
            ? a.modified.localeCompare(b.modified)
            : sort === 'size'
              ? a.size - b.size
              : a.path.localeCompare(b.path);
        return desc ? -c : c;
      });
      const truncated = entries.length > max;
      return ok(
        JSON.stringify({
          path,
          total: entries.length,
          entries: entries.slice(0, max),
          ...(truncated ? { truncated: true } : {}),
        }),
      );
    },
  };

  const read: RegisteredTool = {
    definition: {
      name: 'fs_read',
      description:
        'ファイルを読む(許可フォルダ配下のみ)。テキストは本文を返す(長ければ offset / max_chars で続きを読む)。' +
        '画像は取り込んで画像として見せる。動画・PDF は取り込んで video_id / pdf_id を返すので video_* / pdf_* ツールで続きを見る。' +
        'その他のバイナリは encoding=base64 を指定した時だけ返す。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '読むファイルの絶対パス' },
          offset: {
            type: 'integer',
            description: 'テキストの読み始め位置(文字。既定 0)',
            minimum: 0,
          },
          max_chars: {
            type: 'integer',
            description: `返す最大文字数(既定 ${DEFAULT_MAX_CHARS}、上限 ${MAX_CHARS})`,
            minimum: 100,
            maximum: MAX_CHARS,
          },
          encoding: {
            type: 'string',
            enum: ['utf8', 'base64'],
            description: 'バイナリを base64 で欲しい時だけ base64',
          },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
    source: { kind: 'builtin' },
    category: 'files',
    defaultPolicy: 'auto',
    unavailable,
    execute: async (args) => {
      const path = await checkPath(str(args, 'path'), roots(), 'read');
      const st = await fs.stat(path).catch(() => null);
      if (!st) return fail(`ファイルが見つかりません: ${path}`);
      if (st.isDirectory()) return fail(`フォルダです(fs_list を使ってください): ${path}`);
      if (!st.isFile()) return fail(`通常のファイルではありません: ${path}`);
      const maxChars = Math.floor(num(args, 'max_chars', DEFAULT_MAX_CHARS, 100, MAX_CHARS));
      const offset = Math.floor(num(args, 'offset', 0, 0));
      const base64 = args['encoding'] === 'base64';
      const mime = mimeFromName(path);
      const kind = kindFromMime(mime);
      const name = basename(path);

      if (base64) {
        if (st.size > MAX_BINARY_BYTES)
          return fail(`大きすぎます(${st.size} バイト、上限 ${MAX_BINARY_BYTES})`);
        const buf = await fs.readFile(path);
        return ok(JSON.stringify({ path, size: st.size, mime, base64: buf.toString('base64') }));
      }

      if (kind === 'image') {
        const a = await store.addFile(path, { originalName: name, mime });
        const media: ToolMedia = { attachmentId: a.id, mime: a.mime, kind: 'image', label: name };
        return ok(
          JSON.stringify({
            path,
            kind: 'image',
            image_id: a.id,
            size: a.size,
            ...(a.meta.width ? { width: a.meta.width, height: a.meta.height } : {}),
            note: 'この画像はモデルに渡されます',
          }),
          [media],
        );
      }
      if (kind === 'video' || kind === 'audio') {
        const a = await store.addFile(path, { originalName: name, mime });
        return ok(
          JSON.stringify({
            path,
            kind,
            ...(kind === 'video' ? { video_id: a.id } : { audio_id: a.id }),
            size: a.size,
            duration_ms: a.meta.durationMs ?? null,
            ...(a.meta.width ? { width: a.meta.width, height: a.meta.height } : {}),
            note:
              kind === 'video'
                ? '添付として取り込みました。中身は video_info / video_frames などの動画ツールで見てください'
                : '添付として取り込みました',
          }),
        );
      }
      if (mime === 'application/pdf') {
        const a = await store.addFile(path, { originalName: name, mime });
        const pages: { page: number; text: string }[] = [];
        let numPages = a.meta.pageCount ?? 0;
        if (pdf) {
          let used = 0;
          const r = await pdf.extractText(path, 1, 20);
          numPages = r.numPages;
          for (const p of r.pages) {
            if (used >= maxChars) break;
            const text = p.text.slice(0, maxChars - used);
            used += text.length;
            pages.push({ page: p.page, text });
          }
        }
        return ok(
          JSON.stringify({
            path,
            kind: 'pdf',
            pdf_id: a.id,
            num_pages: numPages,
            pages,
            note: '続きのページは pdf_text、図表は pdf_pages で',
          }),
        );
      }

      if (st.size > MAX_TEXT_BYTES)
        return fail(`大きすぎます(${st.size} バイト、上限 ${MAX_TEXT_BYTES})`);
      const buf = await fs.readFile(path);
      if (!looksText(mime, path, buf.subarray(0, 8192)))
        return fail(
          `バイナリファイルのようです(${mime}、${st.size} バイト)。中身が必要なら encoding=base64 を指定してください`,
        );
      const full = buf.toString('utf8');
      const text = full.slice(offset, offset + maxChars);
      const truncated = offset + text.length < full.length;
      return ok(
        JSON.stringify({
          path,
          size: st.size,
          total_chars: full.length,
          offset,
          text,
          ...(truncated ? { truncated: true, next_offset: offset + text.length } : {}),
        }),
      );
    },
  };

  const write: RegisteredTool = {
    definition: {
      name: 'fs_write',
      description:
        'ファイルを書く(書き込み可の許可フォルダ配下のみ)。親フォルダは無ければ作る。' +
        'mode=append で追記、create は既存なら失敗。バイナリは encoding=base64 で。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '書き込み先の絶対パス' },
          content: { type: 'string', description: '書き込む内容' },
          encoding: { type: 'string', enum: ['utf8', 'base64'], description: '既定 utf8' },
          mode: {
            type: 'string',
            enum: ['overwrite', 'append', 'create'],
            description: '既定 overwrite',
          },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
    source: { kind: 'builtin' },
    category: 'files',
    defaultPolicy: 'ask',
    unavailable,
    execute: async (args) => {
      const path = await checkPath(str(args, 'path'), roots(), 'write');
      const content = typeof args['content'] === 'string' ? args['content'] : '';
      const data =
        args['encoding'] === 'base64'
          ? Buffer.from(content, 'base64')
          : Buffer.from(content, 'utf8');
      const mode =
        args['mode'] === 'append' || args['mode'] === 'create' ? args['mode'] : 'overwrite';
      const st = await fs.stat(path).catch(() => null);
      if (st?.isDirectory()) return fail(`フォルダです: ${path}`);
      if (mode === 'create' && st) return fail(`既に存在します: ${path}`);
      await fs.mkdir(dirname(path), { recursive: true });
      if (mode === 'append') await fs.appendFile(path, data);
      else await fs.writeFile(path, data);
      const after = await fs.stat(path);
      return ok(JSON.stringify({ path, bytes: data.length, size: after.size, created: !st }));
    },
  };

  // 説明文に許可フォルダを載せる(モデルがパスを推測しやすいように)。定義は送信時に毎回読まれる
  const withRootsHint = (t: RegisteredTool): RegisteredTool => {
    const base = t.definition;
    return {
      ...t,
      get definition() {
        return { ...base, description: base.description + rootsHint() };
      },
    };
  };
  return [list, read, write].map(withRootsHint);
}

import { promises as fs } from 'node:fs';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import type { MediaStore } from '@main/media/store';
import type { RegisteredTool, ToolContext, ToolMedia } from '../types';
import { fail, num, ok, str } from '../types';
import { runJavaScript, type SandboxHost } from './js-sandbox';
import {
  referenceHint,
  SANDBOX_REFERENCE,
  SANDBOX_SUMMARY,
  staticHints,
  typeErrorHint,
} from './js-sandbox-reference';
import { describeDownloaded, downloadToStore, MAX_DOWNLOAD_BYTES } from './download';

/**
 * run_javascript: QuickJS(WASM)サンドボックスでコードを実行する(M11)。
 * ファイル・ネットワークは呼び出し時に宣言した allow_* の範囲だけ、ホスト関数経由で許可する。
 * 設計は docs/plan/07-feedback-round-1.md。
 */

export interface CodeToolDeps {
  store: MediaStore;
  /** サンドボックスから他のツールを呼ぶ(udjat.callTool)。ポリシー auto のものだけ通す(M16) */
  callTool?: (
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<{ text: string; isError: boolean }>;
}

const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_TIMEOUT_MS = 30_000;
/** background: true の時の制限時間(既定 1 時間、上限 6 時間) */
const BG_DEFAULT_TIMEOUT_MS = 60 * 60_000;
const BG_MAX_TIMEOUT_MS = 6 * 60 * 60_000;
const MAX_FETCH_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** allow_download を宣言しない時に udjat.download で受け取れる上限 */
const DEFAULT_DOWNLOAD_BYTES = 5 * 1024 * 1024;
const TEXTUAL_MIME =
  /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|toml|x-www-form-urlencoded))/;

function strList(args: Record<string, unknown>, key: string): string[] {
  const v = args[key];
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
    .map((x) => x.trim());
}

/** 宣言されたパス(ファイルまたはディレクトリ)の配下かどうか。Windows は大文字小文字を無視 */
export function pathAllowed(target: string, allowed: string[]): boolean {
  const norm = (p: string) => {
    const r = resolve(p);
    return process.platform === 'win32' ? r.toLowerCase() : r;
  };
  const t = norm(target);
  for (const a of allowed) {
    const base = norm(a);
    if (t === base) return true;
    const prefix = base.endsWith(sep) ? base : base + sep;
    if (t.startsWith(prefix)) return true;
  }
  return false;
}

/** "example.com" / "*.example.com" / "host:8080" の一致 */
export function hostAllowed(url: URL, allowed: string[]): boolean {
  const host = url.hostname.toLowerCase();
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  for (const raw of allowed) {
    const a = raw
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '');
    const [ah, ap] = a.includes(':') && !a.startsWith('[') ? a.split(':') : [a, undefined];
    if (ap !== undefined && ap !== port) continue;
    if (!ah) continue;
    if (ah.startsWith('*.')) {
      const suffix = ah.slice(1); // ".example.com"
      if (host.endsWith(suffix) && host.length > suffix.length) return true;
    } else if (ah === host) return true;
  }
  return false;
}

function permissionError(what: string, hint: string): never {
  throw new Error(`permission denied: ${what}. ${hint}`);
}

export function createCodeTools({ store, callTool }: CodeToolDeps): RegisteredTool[] {
  const runJs: RegisteredTool = {
    definition: {
      name: 'run_javascript',
      description:
        'JavaScript をサンドボックスで実行し、console 出力と返り値を返す。計算、データ整形、文字列処理、添付ファイルの解析、API のポーリングに使う。' +
        SANDBOX_SUMMARY +
        ' ファイルやネットワークに触るには allow_read / allow_write / allow_net を宣言する(宣言外は permission denied)。' +
        ' バイナリ(生成画像など)は udjat.download(url) で添付に取り込む(画像はそのままモデルに見える)。5MB を超えるダウンロードは allow_download にバイト数を宣言する。' +
        'いずれの API も Promise を返すので await する。トップレベル await 可。結果は return で返す(console 出力も返る)。' +
        '数十秒を超える処理(ポーリング等)は background: true を付けると、バックグラウンドタスクになり完了後に応答が再開される。',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: '実行するコード' },
          allow_read: {
            type: 'array',
            items: { type: 'string' },
            description: '読み取りを許可するファイル/ディレクトリの絶対パス',
          },
          allow_write: {
            type: 'array',
            items: { type: 'string' },
            description: '書き込みを許可するファイル/ディレクトリの絶対パス',
          },
          allow_net: {
            type: 'array',
            items: { type: 'string' },
            description: '許可するホスト(example.com / *.example.com / host:port)',
          },
          allow_download: {
            type: 'integer',
            description: `udjat.download で受け取る最大バイト数。宣言しなければ ${DEFAULT_DOWNLOAD_BYTES} まで。大きいファイルはここに宣言する(承認が必要)`,
            minimum: 1,
            maximum: MAX_DOWNLOAD_BYTES,
          },
          timeout_ms: {
            type: 'integer',
            description: `制限時間ミリ秒(既定 ${DEFAULT_TIMEOUT_MS}、上限 ${MAX_TIMEOUT_MS}。background: true なら既定 ${BG_DEFAULT_TIMEOUT_MS}、上限 ${BG_MAX_TIMEOUT_MS})`,
            minimum: 1000,
            maximum: BG_MAX_TIMEOUT_MS,
          },
          background: {
            type: 'boolean',
            description:
              '長時間かかる処理(ジョブの完了待ちなど)なら true。バックグラウンドタスクとして実行し、完了後に応答を再開する',
          },
        },
        required: ['code'],
        additionalProperties: false,
      },
    },
    source: { kind: 'builtin' },
    category: 'code',
    defaultPolicy: 'ask',
    // 権限を 1 つでも宣言した呼び出しは、ポリシーや会話単位の常時許可に関わらず必ず確認する
    requiresApproval: (args) =>
      strList(args, 'allow_read').length > 0 ||
      strList(args, 'allow_write').length > 0 ||
      strList(args, 'allow_net').length > 0 ||
      (typeof args['allow_download'] === 'number' && args['allow_download'] > 0),
    // background: true はすぐにバックグラウンドタスクへ切り離す(M16)
    background: (args) => args['background'] === true,
    execute: async (args, ctx) => {
      const code = str(args, 'code');
      const allowRead = strList(args, 'allow_read');
      const allowWrite = strList(args, 'allow_write');
      const allowNet = strList(args, 'allow_net');
      for (const p of [...allowRead, ...allowWrite]) {
        if (!isAbsolute(p))
          return fail(`allow_read / allow_write は絶対パスで指定してください: ${p}`);
      }
      const allowDownload =
        typeof args['allow_download'] === 'number' && args['allow_download'] > 0
          ? Math.min(Math.floor(args['allow_download']), MAX_DOWNLOAD_BYTES)
          : DEFAULT_DOWNLOAD_BYTES;
      /** この実行でダウンロードした画像(ツール結果の media として見せる) */
      const downloadedMedia: ToolMedia[] = [];
      const background = args['background'] === true;
      const timeoutMs = background
        ? num(args, 'timeout_ms', BG_DEFAULT_TIMEOUT_MS, 1000, BG_MAX_TIMEOUT_MS)
        : num(args, 'timeout_ms', DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS);

      const host: SandboxHost = {
        async readFile(path, encoding) {
          if (!pathAllowed(path, allowRead) && !pathAllowed(path, allowWrite))
            permissionError(
              `read ${path}`,
              'allow_read にこのパス(または親ディレクトリ)を宣言して再実行してください',
            );
          const st = await fs.stat(path);
          if (st.size > MAX_FILE_BYTES)
            throw new Error(`file too large (${st.size} bytes, max ${MAX_FILE_BYTES})`);
          const buf = await fs.readFile(path);
          return encoding === 'base64' ? buf.toString('base64') : buf.toString('utf8');
        },
        async writeFile(path, data, encoding) {
          if (!pathAllowed(path, allowWrite))
            permissionError(
              `write ${path}`,
              'allow_write にこのパス(または親ディレクトリ)を宣言して再実行してください',
            );
          await fs.writeFile(path, encoding === 'base64' ? Buffer.from(data, 'base64') : data);
        },
        async readDir(path) {
          if (!pathAllowed(path, allowRead) && !pathAllowed(path, allowWrite))
            permissionError(
              `readdir ${path}`,
              'allow_read にこのディレクトリを宣言して再実行してください',
            );
          const entries = await fs.readdir(path, { withFileTypes: true });
          return entries.map((e) => ({
            name: e.name,
            type: e.isDirectory() ? 'dir' : e.isFile() ? 'file' : 'other',
          }));
        },
        async fetch(url, init) {
          let u: URL;
          try {
            u = new URL(url);
          } catch {
            throw new Error(`invalid url: ${url}`);
          }
          if (u.protocol !== 'http:' && u.protocol !== 'https:')
            throw new Error(`unsupported protocol: ${u.protocol}`);
          if (!hostAllowed(u, allowNet))
            permissionError(
              `fetch ${u.host}`,
              'allow_net にこのホストを宣言して再実行してください',
            );
          const controller = new AbortController();
          const onAbort = () => controller.abort();
          ctx.signal.addEventListener('abort', onAbort, { once: true });
          const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 60_000));
          try {
            const res = await globalThis.fetch(u, {
              method: init?.method ?? 'GET',
              headers: init?.headers ?? {},
              body: init?.body ?? null,
              signal: controller.signal,
              redirect: 'follow',
            });
            const buf = Buffer.from(await res.arrayBuffer());
            const headers: Record<string, string> = {};
            res.headers.forEach((v, k) => (headers[k] = v));
            const truncated = buf.length > MAX_FETCH_BYTES;
            const ctype = (headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
            const binary = ctype !== '' && !TEXTUAL_MIME.test(ctype);
            const body = buf.subarray(0, MAX_FETCH_BYTES);
            return {
              status: res.status,
              headers,
              text: binary ? '' : body.toString('utf8'),
              truncated,
              ...(binary ? { base64: body.toString('base64') } : {}),
            };
          } finally {
            clearTimeout(timer);
            ctx.signal.removeEventListener('abort', onAbort);
          }
        },
        async listAttachments() {
          return store.listForConversation(ctx.conversationId).map((a) => ({
            id: a.id,
            name: a.originalName,
            mime: a.mime,
            size: a.size,
            kind: a.meta.kind,
          }));
        },
        async readAttachment(id, encoding) {
          const a = store.get(id);
          if (!a) throw new Error(`attachment not found: ${id}`);
          if (a.size > MAX_FILE_BYTES)
            throw new Error(`attachment too large (${a.size} bytes, max ${MAX_FILE_BYTES})`);
          const buf = await fs.readFile(store.pathOf(a));
          return encoding === 'base64' ? buf.toString('base64') : buf.toString('utf8');
        },
        async download(url, opts) {
          let u: URL;
          try {
            u = new URL(url);
          } catch {
            throw new Error(`invalid url: ${url}`);
          }
          if (!hostAllowed(u, allowNet))
            permissionError(
              `download ${u.host}`,
              'allow_net にこのホストを宣言して再実行してください',
            );
          const maxBytes = Math.min(opts.maxBytes ?? allowDownload, allowDownload);
          if (opts.saveTo !== undefined && !pathAllowed(opts.saveTo, allowWrite))
            permissionError(
              `write ${opts.saveTo}`,
              'saveTo に書くには allow_write にそのパス(または親ディレクトリ)を宣言してください',
            );
          let d;
          try {
            d = await downloadToStore(store, u.href, {
              maxBytes,
              signal: ctx.signal,
              skipGuard: true,
              ...(opts.name ? { name: opts.name } : {}),
            });
          } catch (e) {
            const msg = (e as Error).message;
            throw new Error(
              /サイズ上限/.test(msg) && maxBytes >= allowDownload
                ? `${msg}。より大きいファイルは allow_download にバイト数を宣言して再実行してください`
                : msg,
            );
          }
          if (opts.saveTo !== undefined) {
            await fs.mkdir(dirname(opts.saveTo), { recursive: true });
            await fs.copyFile(store.pathOf(d.attachment), opts.saveTo);
          }
          const { body, media } = describeDownloaded(
            d,
            opts.saveTo !== undefined ? { saved_to: opts.saveTo } : {},
          );
          if (downloadedMedia.length < 8) downloadedMedia.push(...media);
          return body;
        },
        sleep(ms) {
          return new Promise<void>((resolve) => {
            const t = setTimeout(done, Math.min(ms, timeoutMs));
            function done() {
              ctx.signal.removeEventListener('abort', done);
              clearTimeout(t);
              resolve();
            }
            ctx.signal.addEventListener('abort', done, { once: true });
          });
        },
        async callTool(name, toolArgs) {
          if (!callTool) throw new Error('udjat.callTool はこの構成では使えません');
          if (name === 'run_javascript')
            throw new Error('run_javascript を入れ子で呼ぶことはできません');
          return callTool(name, toolArgs, ctx);
        },
      };

      const r = await runJavaScript(code, { timeoutMs, host, signal: ctx.signal });
      const payload: Record<string, unknown> = {
        ok: r.ok,
        result: r.result,
        stdout: r.stdout,
        stderr: r.stderr,
        duration_ms: r.durationMs,
      };
      if (!r.ok) {
        // Node.js / ブラウザ前提の書き方で失敗した時は、対応する書き方を添える(M17 / M19)
        const error = r.error || 'Error: (no message)';
        const hints = [referenceHint(error), typeErrorHint(error), ...staticHints(code)].filter(
          (h): h is string => !!h,
        );
        payload['error'] =
          hints.length > 0 ? `${error}\nヒント: ${[...new Set(hints)].join(' / ')}` : error;
      } else if (r.result === undefined) {
        payload['note'] =
          'result が無い: 値を返すには最後に return する(関数を呼ぶだけでは返らない)。console 出力は stdout にある';
      }
      if (r.truncated) payload['truncated'] = '出力が上限で打ち切られました';
      if (downloadedMedia.length > 0)
        payload['downloaded_images'] = `${downloadedMedia.length} 枚の画像をモデルに渡します`;
      const text = JSON.stringify(payload);
      return r.ok ? ok(text, downloadedMedia) : { text, isError: true, media: downloadedMedia };
    },
  };

  const reference: RegisteredTool = {
    definition: {
      name: 'js_sandbox_reference',
      description:
        'run_javascript のサンドボックス(QuickJS)で使える API と制限、Node.js 風のコードの書き換え方を Markdown で返す。' +
        'run_javascript を書く前や、ReferenceError などで失敗した後に参照する。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    source: { kind: 'builtin' },
    category: 'code',
    defaultPolicy: 'auto',
    execute: async () => ok(SANDBOX_REFERENCE),
  };
  return [runJs, reference];
}

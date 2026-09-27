import { promises as fs } from 'node:fs';
import { isAbsolute, resolve, sep } from 'node:path';
import type { MediaStore } from '@main/media/store';
import type { RegisteredTool } from '../types';
import { fail, num, ok, str } from '../types';
import { runJavaScript, type SandboxHost } from './js-sandbox';

/**
 * run_javascript: QuickJS(WASM)サンドボックスでコードを実行する(M11)。
 * ファイル・ネットワークは呼び出し時に宣言した allow_* の範囲だけ、ホスト関数経由で許可する。
 * 設計は docs/plan/07-feedback-round-1.md。
 */

export interface CodeToolDeps {
  store: MediaStore;
}

const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_FETCH_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

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

export function createCodeTools({ store }: CodeToolDeps): RegisteredTool[] {
  const runJs: RegisteredTool = {
    definition: {
      name: 'run_javascript',
      description:
        'JavaScript(ES2023)をサンドボックスで実行し、console 出力と返り値を返す。計算、データ整形、文字列処理、添付ファイルの解析に使う。' +
        'ファイルやネットワークに触るには allow_read / allow_write / allow_net を宣言する(宣言外はエラー)。' +
        'サンドボックス内 API: udjat.readFile(path, encoding?) / udjat.writeFile(path, data) / udjat.readDir(path) / ' +
        'udjat.fetch(url, {method, headers, body}) -> {status, headers, text} / udjat.attachments() / udjat.readAttachment(id, encoding?)。' +
        'いずれも Promise を返すので await する。トップレベル await 可。結果は console.log か return で返す。npm パッケージ・require・DOM は使えない。',
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
          timeout_ms: {
            type: 'integer',
            description: `制限時間ミリ秒(既定 ${DEFAULT_TIMEOUT_MS}、上限 ${MAX_TIMEOUT_MS})`,
            minimum: 1000,
            maximum: MAX_TIMEOUT_MS,
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
      strList(args, 'allow_net').length > 0,
    execute: async (args, ctx) => {
      const code = str(args, 'code');
      const allowRead = strList(args, 'allow_read');
      const allowWrite = strList(args, 'allow_write');
      const allowNet = strList(args, 'allow_net');
      for (const p of [...allowRead, ...allowWrite]) {
        if (!isAbsolute(p))
          return fail(`allow_read / allow_write は絶対パスで指定してください: ${p}`);
      }
      const timeoutMs = num(args, 'timeout_ms', DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS);

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
            return {
              status: res.status,
              headers,
              text: buf.subarray(0, MAX_FETCH_BYTES).toString('utf8'),
              truncated,
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
      };

      const r = await runJavaScript(code, { timeoutMs, host, signal: ctx.signal });
      const payload: Record<string, unknown> = {
        ok: r.ok,
        result: r.result,
        stdout: r.stdout,
        stderr: r.stderr,
        duration_ms: r.durationMs,
      };
      if (r.error) payload['error'] = r.error;
      if (r.truncated) payload['truncated'] = '出力が上限で打ち切られました';
      const text = JSON.stringify(payload);
      return r.ok ? ok(text) : { text, isError: true };
    },
  };
  return [runJs];
}

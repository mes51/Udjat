import type { ServerProfile } from '@shared/schemas';
import { ProviderError, type ProviderErrorCode } from './types';

/**
 * Base URL を正規化する。末尾のスラッシュと `/v1` を落とし、
 * 各アダプタが `${base}/v1/...` や `${base}/api/...` を組み立てられるようにする。
 */
export function normalizeBaseUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, '');
  if (/\/v1$/i.test(u)) u = u.slice(0, -3).replace(/\/+$/, '');
  return u;
}

export function authHeaders(profile: ServerProfile): Record<string, string> {
  const h: Record<string, string> = {};
  const key = profile.apiKey?.trim();
  if (key) h['Authorization'] = `Bearer ${key}`;
  return h;
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal | undefined;
  /** 接続・ヘッダ受信までのタイムアウト(ミリ秒)。ストリーム本体には適用しない */
  timeoutMs?: number;
}

/** fetch が投げた例外を、原因コードと日本語の説明に分類する */
export function classifyFetchError(e: unknown, url: string): ProviderError {
  const err = e as Error & { cause?: { code?: string; message?: string } | Error; code?: string };
  const cause = err.cause;
  const code = (cause && 'code' in cause ? cause.code : undefined) ?? err.code ?? '';
  const detail = cause instanceof Error ? cause.message : (cause?.message ?? err.message);
  let kind: ProviderErrorCode = 'network';
  let hint = '';
  if (code === 'ECONNREFUSED') {
    kind = 'refused';
    hint =
      'ポートに何も待ち受けていません。サーバーが 127.0.0.1 にしかバインドされていない(LAN 公開されていない)か、ポート番号の違いが考えられます。';
  } else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    kind = 'dns';
    hint = 'ホスト名を解決できません。IP アドレスで指定してみてください。';
  } else if (
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    /timeout/i.test(detail)
  ) {
    kind = 'timeout';
    hint =
      '応答がありません。IP アドレスの誤りか、サーバー側 PC のファイアウォールで遮断されている可能性があります。';
  } else if (code === 'ECONNRESET' || code === 'EPIPE') {
    kind = 'network';
    hint = '接続が切断されました。HTTPS/HTTP の取り違えや、サーバー側の再起動が考えられます。';
  } else if (/certificate|SSL|TLS/i.test(detail)) {
    kind = 'tls';
    hint = 'TLS 証明書の検証に失敗しました。LAN 内なら http:// で指定してください。';
  }
  return new ProviderError(
    `${url} に接続できません: ${detail}${hint ? `\n${hint}` : ''}`,
    undefined,
    undefined,
    kind,
  );
}

/** HTTP ステータスからヒントを付ける */
function classifyHttpError(
  status: number,
  path: string,
  body: string,
): { kind: ProviderErrorCode; hint: string } {
  if (status === 401 || status === 403) {
    return {
      kind: 'unauthorized',
      hint: 'API キーが受け付けられていません。プロファイルの API キー(Unsloth なら sk-unsloth- で始まるキー)を確認してください。',
    };
  }
  if (status === 404) {
    return {
      kind: 'not-found',
      hint: `${path} が存在しません。Base URL のパスや、サーバー種別(Ollama か OpenAI 互換か)を確認してください。`,
    };
  }
  if (status >= 500)
    return { kind: 'server', hint: `サーバー側でエラーが発生しました: ${body.slice(0, 200)}` };
  return { kind: 'http', hint: '' };
}

/**
 * fetch の薄いラッパ。非 2xx を ProviderError に変換し、
 * タイムアウトと呼び出し側の AbortSignal を合成する。
 */
export async function request(
  profile: ServerProfile,
  path: string,
  opts: RequestOptions = {},
): Promise<Response> {
  const url = normalizeBaseUrl(profile.baseUrl) + path;
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const timer = setTimeout(
    () => controller.abort(new Error(`timeout after ${timeoutMs}ms`)),
    timeoutMs,
  );
  const onAbort = () => controller.abort(opts.signal?.reason);
  opts.signal?.addEventListener('abort', onAbort, { once: true });

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers: {
        ...authHeaders(profile),
        ...(opts.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        Accept: 'application/json, text/event-stream, application/x-ndjson',
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : null,
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
    if (opts.signal?.aborted) throw e;
    throw classifyFetchError(e, url);
  }
  clearTimeout(timer);
  // ヘッダ受信後は呼び出し側の signal のみで中断する(タイムアウトは外す)
  if (!res.ok) {
    opts.signal?.removeEventListener('abort', onAbort);
    const body = await res.text().catch(() => '');
    const { kind, hint } = classifyHttpError(res.status, path, body);
    throw new ProviderError(
      `${res.status} ${res.statusText} (${opts.method ?? 'GET'} ${path}): ${body.slice(0, 500)}${hint ? `\n${hint}` : ''}`,
      res.status,
      body,
      kind,
    );
  }
  return res;
}

export async function requestJson<T>(
  profile: ServerProfile,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const res = await request(profile, path, opts);
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError(
      `${path} の応答が JSON ではありません(先頭: ${text.slice(0, 120).replace(/\s+/g, ' ')})。Base URL が Web UI のページを指している可能性があります。`,
      res.status,
      text,
      'not-json',
    );
  }
}

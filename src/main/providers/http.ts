import type { ServerProfile } from '@shared/schemas';
import { ProviderError } from './types';

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
  if (profile.apiKey) h['Authorization'] = `Bearer ${profile.apiKey}`;
  return h;
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  signal?: AbortSignal | undefined;
  /** 接続・ヘッダ受信までのタイムアウト(ミリ秒)。ストリーム本体には適用しない */
  timeoutMs?: number;
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
    throw new ProviderError(
      `${url} に接続できません: ${(e as Error).cause ?? (e as Error).message}`,
    );
  }
  clearTimeout(timer);
  // ヘッダ受信後は呼び出し側の signal のみで中断する(タイムアウトは外す)
  if (!res.ok) {
    opts.signal?.removeEventListener('abort', onAbort);
    const body = await res.text().catch(() => '');
    throw new ProviderError(
      `${res.status} ${res.statusText} (${opts.method ?? 'GET'} ${path}): ${body.slice(0, 500)}`,
      res.status,
      body,
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
  return (await res.json()) as T;
}

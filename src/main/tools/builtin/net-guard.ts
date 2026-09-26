import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * SSRF 対策。LLM に指示された URL がプライベートアドレス(LLM サーバー自身や
 * ルーターの管理画面など)を指していないか確認する。
 */

export function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number) as [number, number];
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) // CGNAT
    );
  }
  if (isIP(ip) === 6) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fe80:') || v.startsWith('fc') || v.startsWith('fd')) return true;
    // IPv4-mapped
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (m) return isPrivateIp(m[1]!);
    return false;
  }
  return false;
}

export interface UrlGuardOptions {
  /** ホスト名(またはホスト:ポート)の許可リスト。プライベートでも許可する */
  allowHosts?: string[];
  resolve?: (host: string) => Promise<string[]>;
}

async function defaultResolve(host: string): Promise<string[]> {
  const rs = await lookup(host, { all: true });
  return rs.map((r) => r.address);
}

/** 取得して良い URL か検査する。ダメなら理由を返す */
export async function checkUrl(
  raw: string,
  opts: UrlGuardOptions = {},
): Promise<{ ok: true; url: URL } | { ok: false; reason: string }> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'URL の形式が不正です' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `http / https 以外は取得できません (${url.protocol})` };
  }
  if (url.username || url.password)
    return { ok: false, reason: 'URL に認証情報を含めることはできません' };

  const host = url.hostname.replace(/^\[|\]$/g, '');
  const allow = new Set((opts.allowHosts ?? []).map((h) => h.toLowerCase()));
  if (allow.has(host.toLowerCase()) || allow.has(`${host}:${url.port}`.toLowerCase()))
    return { ok: true, url };

  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    return { ok: false, reason: 'ローカルホストへの要求は許可されていません' };
  }
  if (isIP(host)) {
    if (isPrivateIp(host))
      return { ok: false, reason: `プライベートアドレス ${host} への要求は許可されていません` };
    return { ok: true, url };
  }
  let addrs: string[];
  try {
    addrs = await (opts.resolve ?? defaultResolve)(host);
  } catch {
    return { ok: false, reason: `ホスト名を解決できません: ${host}` };
  }
  const bad = addrs.find(isPrivateIp);
  if (bad) return { ok: false, reason: `${host} はプライベートアドレス ${bad} を指しています` };
  return { ok: true, url };
}

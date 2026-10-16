import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { ApprovalScope } from '../types';

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

/**
 * 承認の単位にするドメイン(M24)。ホスト名を小文字にし、先頭の "www." は落とす
 * (www.example.com と example.com を同じ許可で通す)。IP アドレスはそのまま
 */
export function approvalDomain(hostname: string): string {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isIP(h)) return h;
  return h.replace(/^www\./, '');
}

/** ホストが承認済みドメインに含まれるか(同じか、そのサブドメイン) */
export function domainCovers(approved: string, hostname: string): boolean {
  const h = approvalDomain(hostname);
  const a = approved.toLowerCase();
  return h === a || h.endsWith(`.${a}`);
}

/**
 * URL を取るツールの承認範囲(M24)。設定 webFetch.domainApproval が false なら範囲の承認は使わない(既定は使う)。
 * URL が壊れていれば null(実行時に別のエラーになる)
 */
export function urlApprovalScope(
  rawUrl: unknown,
  getSetting: (key: string) => unknown,
  action = '取得',
): ApprovalScope | null {
  if (getSetting('webFetch.domainApproval') === false) return null;
  if (typeof rawUrl !== 'string') return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const domain = approvalDomain(url.hostname);
  return {
    key: `host:${domain}`,
    label: domain,
    description: `${action}: ${url.href.length > 200 ? `${url.href.slice(0, 200)}…` : url.href}`,
  };
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

import { describe, expect, it } from 'vitest';
import { approvalDomain, domainCovers, urlApprovalScope } from './net-guard';

/** ドメイン単位の承認範囲(M24) */
describe('approval scope for URLs', () => {
  it('normalizes hosts and matches subdomains', () => {
    expect(approvalDomain('WWW.Example.com')).toBe('example.com');
    expect(approvalDomain('docs.example.com')).toBe('docs.example.com');
    expect(approvalDomain('192.168.0.5')).toBe('192.168.0.5');
    expect(approvalDomain('[::1]')).toBe('::1');
    expect(domainCovers('example.com', 'www.example.com')).toBe(true);
    expect(domainCovers('example.com', 'api.example.com')).toBe(true);
    expect(domainCovers('example.com', 'example.com.evil.net')).toBe(false);
    expect(domainCovers('example.com', 'notexample.com')).toBe(false);
  });

  it('builds a scope from the url unless the setting turns it off', () => {
    const on = () => null;
    expect(urlApprovalScope('https://www.example.com/a/b?x=1', on, '取得')).toEqual({
      key: 'host:example.com',
      label: 'example.com',
      description: '取得: https://www.example.com/a/b?x=1',
    });
    expect(urlApprovalScope('ftp://example.com/x', on)).toBeNull();
    expect(urlApprovalScope('not a url', on)).toBeNull();
    expect(urlApprovalScope(42, on)).toBeNull();
    const off = (k: string) => (k === 'webFetch.domainApproval' ? false : null);
    expect(urlApprovalScope('https://example.com/', off)).toBeNull();
    // 長い URL は切り詰める
    const long = `https://example.com/${'a'.repeat(300)}`;
    expect(urlApprovalScope(long, on)!.description!.length).toBeLessThan(220);
  });
});

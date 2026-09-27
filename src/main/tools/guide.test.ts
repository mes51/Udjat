import { describe, expect, it } from 'vitest';
import { buildToolGuide } from './guide';

describe('buildToolGuide', () => {
  const defs = (...names: string[]) =>
    names.map((name) => ({ name, description: '', parameters: {} }));

  it('returns null without tools and mentions roots, QuickJS rules and download when relevant', () => {
    expect(buildToolGuide([], () => null)).toBeNull();
    const g = buildToolGuide(defs('run_javascript', 'web_download', 'fs_read'), (k) =>
      k === 'fs.roots' ? [{ path: 'D:\\gen', write: true }] : null,
    )!;
    expect(g).toContain('# ツール利用の手引き');
    expect(g).toContain('D:\\gen(書込可)');
    expect(g).toContain('QuickJS');
    expect(g).toContain('return');
    expect(g).toContain('allow_net');
    expect(g).toContain('udjat.download(url) か web_download');
    expect(g).toContain('fs_read / fs_list');
    const plain = buildToolGuide(defs('web_search'), () => null)!;
    expect(plain).not.toContain('QuickJS');
    expect(plain).toContain('添付されたファイル');
  });
});

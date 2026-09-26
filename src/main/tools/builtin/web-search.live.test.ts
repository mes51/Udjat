import { describe, expect, it } from 'vitest';
import { duckDuckGoBackend } from './web-search';

/**
 * 実際の DuckDuckGo に問い合わせる確認テスト。ネットワークとレートリミットに依存するため
 * 通常は skip し、`LIVE=1 pnpm vitest run web-search.live` で明示的に実行する。
 */
describe.skipIf(!process.env['LIVE'])('DuckDuckGo live', () => {
  it('returns parsed results for a simple query', async () => {
    const results = await duckDuckGoBackend.search('llama.cpp server', {
      maxResults: 5,
      lang: 'jp-jp',
      signal: new AbortController().signal,
    });
    console.log(JSON.stringify(results, null, 2));
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.url).toMatch(/^https?:\/\//);
      expect(r.title.length).toBeGreaterThan(0);
    }
  }, 30_000);
});

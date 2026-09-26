import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '@main/db/client';
import { ToolRegistry } from '../registry';
import type { ToolContext } from '../types';
import {
  clearSearchCache,
  createWebSearchTool,
  parseDuckDuckGoHtml,
  unwrapRedirect,
  type SearchBackend,
} from './web-search';

const HTML_FIXTURE = `
<html><body>
<div class="result results_links results_links_deep web-result">
  <div class="links_main links_deep result__body">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&amp;rut=abc">Example <b>Page</b></a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&amp;rut=abc">This is the <b>snippet</b> text.</a>
  </div>
</div>
<div class="result">
  <h2 class="result__title"><a class="result__a" href="https://direct.example.org/">Direct</a></h2>
  <a class="result__snippet">Second</a>
</div>
<div class="result"><h2><a class="result__a" href="javascript:void(0)">bad</a></h2></div>
</body></html>`;

const LITE_FIXTURE = `
<table>
<tr><td><a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Flite.example.com%2F" class="result-link">Lite result</a></td></tr>
<tr><td class="result-snippet">Lite snippet</td></tr>
</table>`;

describe('parseDuckDuckGoHtml', () => {
  it('parses html.duckduckgo.com results and unwraps redirects', () => {
    expect(parseDuckDuckGoHtml(HTML_FIXTURE, 10)).toEqual([
      {
        title: 'Example Page',
        url: 'https://example.com/page',
        snippet: 'This is the snippet text.',
      },
      { title: 'Direct', url: 'https://direct.example.org/', snippet: 'Second' },
    ]);
  });

  it('falls back to the lite layout and respects max', () => {
    expect(parseDuckDuckGoHtml(LITE_FIXTURE, 10)).toEqual([
      { title: 'Lite result', url: 'https://lite.example.com/', snippet: 'Lite snippet' },
    ]);
    expect(parseDuckDuckGoHtml(HTML_FIXTURE, 1)).toHaveLength(1);
  });

  it('unwraps redirect links', () => {
    expect(unwrapRedirect('//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.b%2Fc%3Fd%3D1&rut=x')).toBe(
      'https://a.b/c?d=1',
    );
    expect(unwrapRedirect('https://plain.example/')).toBe('https://plain.example/');
    expect(unwrapRedirect('mailto:x@y')).toBe('');
  });
});

describe('web_search tool', () => {
  afterEach(() => clearSearchCache());

  function ctx(counters = new Map<string, number>()): ToolContext {
    return {
      conversationId: 'c',
      runId: 'r',
      signal: new AbortController().signal,
      counters,
      getSetting: () => null,
    };
  }

  it('limits searches per run, caches results and returns JSON', async () => {
    let calls = 0;
    const backend: SearchBackend = {
      id: 'fake',
      search: async (q) => {
        calls++;
        return [{ title: `t:${q}`, url: 'https://x/', snippet: 's' }];
      },
    };
    const tool = createWebSearchTool(() => backend);
    const counters = new Map<string, number>();
    const r1 = await tool.execute({ query: 'hello', max_results: 3 }, ctx(counters));
    expect(JSON.parse(r1.text)).toMatchObject({
      query: 'hello',
      backend: 'fake',
      results: [{ title: 't:hello' }],
    });
    await tool.execute({ query: 'hello' }, ctx(counters)); // キャッシュ
    expect(calls).toBe(1);
    await tool.execute({ query: 'third' }, ctx(counters));
    const r4 = await tool.execute({ query: 'fourth' }, ctx(counters));
    expect(r4.isError).toBe(true);
    expect(r4.text).toMatch(/上限/);
  });

  it('is registered with an auto policy and validates arguments', async () => {
    const db = openDatabase({ path: ':memory:' });
    const registry = new ToolRegistry(db);
    registry.register(createWebSearchTool(() => ({ id: 'fake', search: async () => [] })));
    expect(registry.list()).toEqual([
      expect.objectContaining({ name: 'web_search', source: 'builtin', policy: 'auto' }),
    ]);
    const r = await registry.execute('web_search', {}, ctx());
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/query/);
    db.close();
  });
});

import { parseHTML } from 'linkedom';
import type { RegisteredTool, ToolContext } from '../types';
import { fail, num, ok, str, ToolError } from '../types';

/**
 * Web 検索。バックエンドを差し替え可能にし、既定は DuckDuckGo の非公式 HTML エンドポイント。
 * 設計と注意点は docs/plan/04-tools-and-mcp.md を参照。
 */

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchBackend {
  id: string;
  search(
    query: string,
    opts: { maxResults: number; lang: string; signal: AbortSignal },
  ): Promise<SearchResult[]>;
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

export class RateLimitError extends ToolError {
  constructor() {
    super('検索サービスのレートリミットに達しました。しばらく待ってから再試行してください');
  }
}

/** DuckDuckGo の HTML 版検索結果をパースする(html.duckduckgo.com / lite.duckduckgo.com 両対応) */
export function parseDuckDuckGoHtml(html: string, max: number): SearchResult[] {
  const { document } = parseHTML(html);
  const out: SearchResult[] = [];

  // html.duckduckgo.com: <div class="result"> <a class="result__a" href>title</a> <a class="result__snippet">…</a>
  for (const el of document.querySelectorAll('.result')) {
    const a = el.querySelector('a.result__a');
    if (!a) continue;
    const url = unwrapRedirect(a.getAttribute('href') ?? '');
    if (!url) continue;
    const snippet = el.querySelector('.result__snippet')?.textContent?.trim() ?? '';
    out.push({ title: a.textContent?.trim() ?? '', url, snippet });
    if (out.length >= max) return out;
  }
  if (out.length > 0) return out;

  // lite.duckduckgo.com: <a class="result-link" href>title</a> … <td class="result-snippet">…</td>
  const links = [...document.querySelectorAll('a.result-link')];
  const snippets = [...document.querySelectorAll('td.result-snippet')];
  links.forEach((a, i) => {
    if (out.length >= max) return;
    const url = unwrapRedirect(a.getAttribute('href') ?? '');
    if (!url) return;
    out.push({
      title: a.textContent?.trim() ?? '',
      url,
      snippet: snippets[i]?.textContent?.trim() ?? '',
    });
  });
  return out;
}

/** //duckduckgo.com/l/?uddg=<encoded>&rut=… 形式のリダイレクトを実 URL に戻す */
export function unwrapRedirect(href: string): string {
  if (!href) return '';
  let h = href.trim();
  if (h.startsWith('//')) h = `https:${h}`;
  try {
    const u = new URL(h, 'https://duckduckgo.com');
    if (u.hostname.endsWith('duckduckgo.com') && u.pathname.startsWith('/l/')) {
      const target = u.searchParams.get('uddg');
      return target ? decodeURIComponent(target) : '';
    }
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.href;
    return '';
  } catch {
    return '';
  }
}

export const duckDuckGoBackend: SearchBackend = {
  id: 'duckduckgo',
  async search(query, { maxResults, lang, signal }) {
    const attempt = async (endpoint: 'html' | 'lite'): Promise<SearchResult[]> => {
      const base =
        endpoint === 'html'
          ? 'https://html.duckduckgo.com/html/'
          : 'https://lite.duckduckgo.com/lite/';
      const body = new URLSearchParams({ q: query, kl: lang });
      const res = await fetch(base, {
        method: 'POST',
        headers: {
          'User-Agent': USER_AGENT,
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'text/html',
          'Accept-Language': lang.startsWith('jp') ? 'ja,en;q=0.7' : 'en',
        },
        body,
        signal,
      });
      if (res.status === 202 || res.status === 429 || res.status === 403)
        throw new RateLimitError();
      if (!res.ok) throw new ToolError(`DuckDuckGo が ${res.status} を返しました`);
      const html = await res.text();
      if (
        /anomaly|bot detection|If this error persists/i.test(html) &&
        !/result__a|result-link/.test(html)
      ) {
        throw new RateLimitError();
      }
      return parseDuckDuckGoHtml(html, maxResults);
    };
    try {
      return await attempt('html');
    } catch (e) {
      if (signal.aborted) throw e;
      if (e instanceof RateLimitError) {
        await new Promise((r) => setTimeout(r, 1500));
        return attempt('lite');
      }
      throw e;
    }
  },
};

export function searxngBackend(baseUrl: string): SearchBackend {
  return {
    id: 'searxng',
    async search(query, { maxResults, lang, signal }) {
      const u = new URL('/search', baseUrl);
      u.searchParams.set('q', query);
      u.searchParams.set('format', 'json');
      u.searchParams.set('language', lang.startsWith('jp') ? 'ja' : 'en');
      const res = await fetch(u, { headers: { Accept: 'application/json' }, signal });
      if (!res.ok) throw new ToolError(`SearXNG が ${res.status} を返しました`);
      const data = (await res.json()) as {
        results?: { title?: string; url?: string; content?: string }[];
      };
      return (data.results ?? [])
        .filter((r) => r.url)
        .slice(0, maxResults)
        .map((r) => ({ title: r.title ?? '', url: r.url!, snippet: r.content ?? '' }));
    },
  };
}

export function braveBackend(apiKey: string): SearchBackend {
  return {
    id: 'brave',
    async search(query, { maxResults, lang, signal }) {
      const u = new URL('https://api.search.brave.com/res/v1/web/search');
      u.searchParams.set('q', query);
      u.searchParams.set('count', String(maxResults));
      if (lang.startsWith('jp')) {
        u.searchParams.set('country', 'JP');
        u.searchParams.set('search_lang', 'ja');
      }
      const res = await fetch(u, {
        headers: { Accept: 'application/json', 'X-Subscription-Token': apiKey },
        signal,
      });
      if (!res.ok) throw new ToolError(`Brave Search が ${res.status} を返しました`);
      const data = (await res.json()) as {
        web?: { results?: { title?: string; url?: string; description?: string }[] };
      };
      return (data.web?.results ?? [])
        .filter((r) => r.url)
        .slice(0, maxResults)
        .map((r) => ({ title: r.title ?? '', url: r.url!, snippet: r.description ?? '' }));
    },
  };
}

/** 設定から検索バックエンドを組み立てる */
export function backendFromSettings(getSetting: (k: string) => unknown): SearchBackend {
  const id = getSetting('webSearch.backend');
  if (id === 'searxng') {
    const url = getSetting('webSearch.searxngUrl');
    if (typeof url === 'string' && url.trim()) return searxngBackend(url.trim());
    throw new ToolError('SearXNG の URL が設定されていません');
  }
  if (id === 'brave') {
    const key = getSetting('webSearch.braveApiKey');
    if (typeof key === 'string' && key.trim()) return braveBackend(key.trim());
    throw new ToolError('Brave Search の API キーが設定されていません');
  }
  return duckDuckGoBackend;
}

interface CacheEntry {
  at: number;
  results: SearchResult[];
}
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 10 * 60_000;
export const MAX_SEARCHES_PER_RUN = 3;

export function createWebSearchTool(
  resolveBackend: (ctx: ToolContext) => SearchBackend = (ctx) =>
    backendFromSettings(ctx.getSetting),
): RegisteredTool {
  return {
    definition: {
      name: 'web_search',
      description:
        'Web を検索して、タイトル・URL・抜粋の一覧を返す。最新情報や自分の知らない事柄を調べる時に使う。詳細が必要なら結果の URL を web_fetch で読む。1 回の応答で使えるのは数回まで。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '検索クエリ。具体的なキーワードを使う' },
          max_results: {
            type: 'integer',
            description: '結果の最大件数 (既定 5)',
            minimum: 1,
            maximum: 10,
          },
          lang: {
            type: 'string',
            description: '地域・言語コード。日本語なら jp-jp、英語なら us-en (既定 jp-jp)',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    source: { kind: 'builtin' },
    category: 'web',
    defaultPolicy: 'auto',
    execute: async (args, ctx) => {
      const query = str(args, 'query');
      const maxResults = num(args, 'max_results', 5, 1, 10);
      const lang = str(args, 'lang', 'jp-jp');

      const used = ctx.counters.get('web_search') ?? 0;
      if (used >= MAX_SEARCHES_PER_RUN) {
        return fail(
          `この応答での検索回数の上限 (${MAX_SEARCHES_PER_RUN} 回) に達しました。手元の結果で回答してください`,
        );
      }
      ctx.counters.set('web_search', used + 1);

      const backend = resolveBackend(ctx);
      const key = `${backend.id}\u0000${lang}\u0000${query.toLowerCase()}`;
      const hit = cache.get(key);
      let results: SearchResult[];
      if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
        results = hit.results;
      } else {
        results = await backend.search(query, { maxResults: 10, lang, signal: ctx.signal });
        cache.set(key, { at: Date.now(), results });
      }
      const sliced = results.slice(0, maxResults);
      if (sliced.length === 0)
        return ok(JSON.stringify({ query, results: [], note: '該当する結果がありません' }));
      return ok(JSON.stringify({ query, backend: backend.id, results: sliced }));
    },
  };
}

export function clearSearchCache(): void {
  cache.clear();
}

import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import type { RegisteredTool, ToolContext } from '../types';
import { fail, num, ok, str } from '../types';
import { checkUrl } from './net-guard';

const MAX_BYTES = 3 * 1024 * 1024;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Udjat/0.1 (+local LLM chat client)';

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});
turndown.use(gfm);
turndown.remove(['script', 'style', 'noscript', 'iframe', 'svg']);

/** 本文を読み切る(サイズ上限つき) */
async function readBody(
  res: Response,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: '', truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
    if (total >= maxBytes) {
      truncated = true;
      void reader.cancel();
      break;
    }
  }
  const buf = Buffer.concat(chunks);
  const charset = /charset=([\w-]+)/i.exec(res.headers.get('content-type') ?? '')?.[1];
  let text: string;
  try {
    text = new TextDecoder(charset ?? 'utf-8').decode(buf);
  } catch {
    text = buf.toString('utf8');
  }
  return { text, truncated };
}

export function htmlToMarkdown(html: string, url: string): { title: string; markdown: string } {
  const { document } = parseHTML(html);
  // Readability は document.location を参照する
  Object.defineProperty(document, 'location', { value: new URL(url), configurable: true });
  const article = new Readability(document as unknown as Document, { charThreshold: 200 }).parse();
  const title = article?.title || document.querySelector('title')?.textContent?.trim() || url;
  const content = article?.content ?? document.body?.innerHTML ?? '';
  let markdown = turndown.turndown(content);
  markdown = markdown.replace(/\n{3,}/g, '\n\n').trim();
  return { title, markdown };
}

export async function fetchAsMarkdown(
  rawUrl: string,
  opts: { maxChars: number; signal: AbortSignal; allowHosts?: string[] },
): Promise<{ text: string; isError?: boolean }> {
  const check = await checkUrl(rawUrl, opts.allowHosts ? { allowHosts: opts.allowHosts } : {});
  if (!check.ok) return { text: `error: ${check.reason}`, isError: true };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('timeout')), 20_000);
  const onAbort = () => controller.abort(opts.signal.reason);
  opts.signal.addEventListener('abort', onAbort, { once: true });
  try {
    const res = await fetch(check.url, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5',
      },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) return { text: `error: HTTP ${res.status} ${res.statusText}`, isError: true };
    const type = (res.headers.get('content-type') ?? '').toLowerCase();
    const { text: body, truncated } = await readBody(res, MAX_BYTES);

    let title = '';
    let content: string;
    if (type.includes('text/html') || type.includes('xhtml') || (!type && /<html/i.test(body))) {
      const r = htmlToMarkdown(body, res.url || check.url.href);
      title = r.title;
      content = r.markdown;
    } else if (type.includes('application/json')) {
      try {
        content = '```json\n' + JSON.stringify(JSON.parse(body), null, 2) + '\n```';
      } catch {
        content = body;
      }
    } else if (type.startsWith('text/') || type.includes('xml')) {
      content = body;
    } else {
      return {
        text: `error: 対応していない Content-Type です (${type || 'unknown'})`,
        isError: true,
      };
    }

    const chars = [...content];
    let out = chars.length > opts.maxChars ? chars.slice(0, opts.maxChars).join('') : content;
    const notes: string[] = [];
    if (chars.length > opts.maxChars)
      notes.push(`(全 ${chars.length} 文字のうち先頭 ${opts.maxChars} 文字を表示)`);
    if (truncated) notes.push('(本文が大きいため途中までしか取得していません)');
    const header = [`# ${title || res.url || rawUrl}`, `URL: ${res.url || rawUrl}`, ...notes].join(
      '\n',
    );
    out = `${header}\n\n${out}`;
    return { text: out };
  } catch (e) {
    if (opts.signal.aborted) throw e;
    const cause = (e as Error & { cause?: Error }).cause;
    return {
      text: `error: 取得に失敗しました: ${cause?.message ?? (e as Error).message}`,
      isError: true,
    };
  } finally {
    clearTimeout(timer);
    opts.signal.removeEventListener('abort', onAbort);
  }
}

export const webFetchTool: RegisteredTool = {
  definition: {
    name: 'web_fetch',
    description:
      '指定した URL のページを取得し、本文を Markdown にして返す。検索結果の詳細を読む時や、ユーザーが URL を示した時に使う。HTML / テキスト / JSON に対応。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '取得する URL (http / https)' },
        max_chars: {
          type: 'integer',
          description: '返す最大文字数 (既定 20000)',
          minimum: 500,
          maximum: 100000,
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  source: { kind: 'builtin' },
  defaultPolicy: 'auto',
  execute: async (args, ctx: ToolContext) => {
    const url = str(args, 'url');
    const maxChars = num(args, 'max_chars', 20000, 500, 100000);
    const allow = ctx.getSetting('webFetch.allowHosts');
    const allowHosts = Array.isArray(allow)
      ? allow.filter((x): x is string => typeof x === 'string')
      : [];
    const r = await fetchAsMarkdown(url, { maxChars, signal: ctx.signal, allowHosts });
    return r.isError ? fail(r.text.replace(/^error: /, '')) : ok(r.text);
  },
};

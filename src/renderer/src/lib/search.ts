/**
 * 会話内検索(M22)の純粋な部分。表示中のメッセージ本文(DOM)を走査して一致箇所の Range を集め、
 * CSS Custom Highlight API で色を付ける。Markdown の描画結果をそのまま対象にするので、
 * 太字やコードをまたぐ一致も 1 つとして扱える。
 */

export interface SearchOptions {
  caseSensitive: boolean;
  regex: boolean;
}

/** クエリから RegExp を作る。正規表現モードで不正なら error を返す */
export function buildSearchRegex(
  query: string,
  opts: SearchOptions,
): { re: RegExp | null; error: string | null } {
  if (query === '') return { re: null, error: null };
  const flags = opts.caseSensitive ? 'g' : 'gi';
  const source = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return { re: new RegExp(source, flags), error: null };
  } catch (e) {
    // V8 のメッセージ "Invalid regular expression: /(/gi: Unterminated group" から理由だけ残す
    return {
      re: null,
      error: (e as Error).message.replace(/^Invalid regular expression: \/.*\/[a-z]*: /, ''),
    };
  }
}

/** 文字列中の一致区間 [start, end)。空一致は無視する */
export function findMatches(text: string, re: RegExp): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  re.lastIndex = 0;
  for (;;) {
    const m = re.exec(text);
    if (!m) break;
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    out.push({ start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** 名前付きハイライト(index.css の ::highlight() と対応) */
export const HIGHLIGHT_ALL = 'udjat-search';
export const HIGHLIGHT_CURRENT = 'udjat-search-current';

/**
 * root 配下の `[data-search-text]` 要素のテキストを走査し、一致箇所を Range にして文書順で返す。
 * 1 つの要素内では子要素をまたぐテキストを連結してから検索する(太字の途中でも一致する)。
 */
export function collectRanges(root: ParentNode, re: RegExp): Range[] {
  const ranges: Range[] = [];
  for (const scope of root.querySelectorAll('[data-search-text]')) {
    const nodes: Text[] = [];
    const offsets: number[] = [];
    let text = '';
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n as Text;
      nodes.push(t);
      offsets.push(text.length);
      text += t.data;
    }
    if (text === '') continue;
    for (const m of findMatches(text, re)) {
      const range = document.createRange();
      const s = locate(nodes, offsets, m.start);
      const e = locate(nodes, offsets, m.end, true);
      if (!s || !e) continue;
      range.setStart(s.node, s.offset);
      range.setEnd(e.node, e.offset);
      ranges.push(range);
    }
  }
  return ranges;
}

/** 連結文字列上の位置を (テキストノード, ノード内オフセット) に戻す。end=true なら区間末尾用 */
function locate(
  nodes: Text[],
  offsets: number[],
  pos: number,
  end = false,
): { node: Text; offset: number } | null {
  // 末尾側はノード境界ちょうどの位置を前のノードの末尾として扱う(空 Range を避ける)
  let i = offsets.findLastIndex((o) => (end ? o < pos : o <= pos));
  if (i < 0) i = 0;
  const node = nodes[i];
  const base = offsets[i];
  if (!node || base === undefined) return null;
  return { node, offset: Math.min(node.data.length, pos - base) };
}

/** Highlight API が使える環境か(Electron の Chromium では使える) */
export function highlightsSupported(): boolean {
  return typeof CSS !== 'undefined' && 'highlights' in CSS && typeof Highlight !== 'undefined';
}

/** 一致箇所と現在位置をハイライトに登録する。ranges が空なら消す */
export function applyHighlights(ranges: Range[], current: number): void {
  if (!highlightsSupported()) return;
  if (ranges.length === 0) {
    clearHighlights();
    return;
  }
  CSS.highlights.set(HIGHLIGHT_ALL, new Highlight(...ranges));
  const cur = ranges[current];
  if (cur) CSS.highlights.set(HIGHLIGHT_CURRENT, new Highlight(cur));
  else CSS.highlights.delete(HIGHLIGHT_CURRENT);
}

export function clearHighlights(): void {
  if (!highlightsSupported()) return;
  CSS.highlights.delete(HIGHLIGHT_ALL);
  CSS.highlights.delete(HIGHLIGHT_CURRENT);
}

/** Range をスクロール容器の中央に出す */
export function scrollRangeIntoView(container: HTMLElement, range: Range): void {
  const rect = range.getBoundingClientRect();
  const box = container.getBoundingClientRect();
  if (rect.height === 0 && rect.width === 0) {
    // 折りたたみ等で可視でない場合は親要素で代用する
    const el =
      range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
    el?.scrollIntoView({ block: 'center' });
    return;
  }
  const delta = rect.top - box.top - container.clientHeight / 2 + rect.height / 2;
  container.scrollBy({ top: delta });
}

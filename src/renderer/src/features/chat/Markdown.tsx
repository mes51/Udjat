import { memo, useEffect, useState, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { Check, Copy } from 'lucide-react';
import { bundledLanguages, createHighlighter, type Highlighter } from 'shiki';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { Button } from '@renderer/components/ui/button';

// ダーク/ライトの両テーマを CSS 変数で出力し、index.css 側で data-theme に応じて切り替える
const THEMES = { dark: 'github-dark-default', light: 'github-light-default' } as const;

// WASM(Oniguruma)は CSP の script-src 'self' で弾かれるため JS 正規表現エンジンを使う。
// 言語は必要になった時に遅延ロードする。
let highlighterPromise: Promise<Highlighter> | null = null;
function getHighlighter(): Promise<Highlighter> {
  highlighterPromise ??= createHighlighter({
    themes: [THEMES.dark, THEMES.light],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  });
  return highlighterPromise;
}

const LANG_ALIASES: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  yml: 'yaml',
};

/** shiki が知らない言語名は text にフォールバックする */
async function highlight(code: string, lang: string): Promise<string> {
  const hl = await getHighlighter();
  const name = LANG_ALIASES[lang] ?? lang;
  let use = 'text';
  if (name in bundledLanguages) {
    try {
      if (!hl.getLoadedLanguages().includes(name))
        await hl.loadLanguage(name as keyof typeof bundledLanguages);
      use = name;
    } catch {
      use = 'text';
    }
  }
  return hl.codeToHtml(code, { lang: use, themes: THEMES, defaultColor: false });
}

function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [html, setHtml] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    highlight(code, lang)
      .then((h) => alive && setHtml(h))
      .catch((e: unknown) => console.warn('highlight failed', e));
    return () => {
      alive = false;
    };
  }, [code, lang]);

  const copy = () => {
    void navigator.clipboard.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };

  return (
    <div className="group border-border bg-surface relative my-2 overflow-hidden rounded-md border">
      <div className="border-border text-fg-muted flex items-center justify-between border-b px-3 py-1 text-[11px]">
        <span>{lang}</span>
        <Button variant="ghost" size="icon-sm" onClick={copy} aria-label="コピー">
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </Button>
      </div>
      {html ? (
        <div
          className="code-block overflow-x-auto text-[13px] leading-relaxed"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="overflow-x-auto p-3 text-[13px] leading-relaxed">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

function extractCode(children: ReactNode): { code: string; lang: string } | null {
  if (!children || typeof children !== 'object' || !('props' in children)) return null;
  const props = (children as { props: { className?: string; children?: ReactNode } }).props;
  const lang = /language-([\w+-]+)/.exec(props.className ?? '')?.[1] ?? 'text';
  const raw = props.children;
  const code =
    typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.join('') : String(raw ?? '');
  return { code: code.replace(/\n$/, ''), lang };
}

/** breaks: 単独の改行も改行として表示する(ユーザー入力向け。入力欄で書いた通りの行になる) */
export const Markdown = memo(function Markdown({
  text,
  breaks,
}: {
  text: string;
  breaks?: boolean;
}) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={breaks ? [remarkGfm, remarkMath, remarkBreaks] : [remarkGfm, remarkMath]}
        rehypePlugins={[rehypeKatex]}
        components={{
          pre: ({ children }) => {
            const c = extractCode(children);
            return c ? <CodeBlock code={c.code} lang={c.lang} /> : <pre>{children}</pre>;
          },
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {children}
            </a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

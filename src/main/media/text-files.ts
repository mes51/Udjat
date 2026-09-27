/**
 * 「テキストとして読めるファイルか」の判定。fs_read と添付の展開(MediaResolver)で共用する。
 */

const TEXT_MIMES = new Set([
  'application/json',
  'application/xml',
  'application/javascript',
  'application/x-yaml',
  'application/yaml',
  'application/toml',
  'application/x-sh',
]);

const TEXT_EXTS = new Set([
  'txt',
  'md',
  'markdown',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'toml',
  'ini',
  'cfg',
  'conf',
  'csv',
  'tsv',
  'xml',
  'html',
  'htm',
  'css',
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'py',
  'rb',
  'sh',
  'ps1',
  'bat',
  'cmd',
  'go',
  'rs',
  'java',
  'kt',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'sql',
  'log',
  'env',
  'gitignore',
  'svg',
  'prompt',
  'tex',
]);

/** mime / 拡張子 / 先頭バイトからテキストらしさを判定する */
export function looksText(mime: string, name: string, head: Buffer): boolean {
  if (mime.startsWith('text/') || TEXT_MIMES.has(mime)) return true;
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  if (TEXT_EXTS.has(ext)) return true;
  if (head.length === 0) return true;
  if (head.includes(0)) return false;
  // 制御文字(改行・タブ以外)が多ければバイナリ扱い
  let ctrl = 0;
  for (const b of head) if (b < 32 && b !== 9 && b !== 10 && b !== 13) ctrl++;
  return ctrl / head.length < 0.05;
}

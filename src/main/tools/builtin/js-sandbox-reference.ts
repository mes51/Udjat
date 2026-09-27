/**
 * run_javascript サンドボックスのリファレンス(M17)。
 * js_sandbox_reference ツールがそのまま返し、ReferenceError のヒントにも使う。
 * 内容を変えたら docs/plan/10-approval-background-sandbox.md も合わせる。
 */

export const SANDBOX_SUMMARY =
  '実行環境は QuickJS(ES2023)であり Node.js でもブラウザでもない。require / import / process / fs / path / Buffer / npm パッケージ / DOM は使えない。' +
  'ファイルは udjat.readFile / udjat.writeFile / udjat.readDir、HTTP は fetch(Response 風: status / ok / headers.get() / text() / json() / bytes())、バイナリの取り込みは udjat.download(url)、待機は udjat.sleep(ms) / setTimeout、' +
  '他のツールは udjat.callTool(name, args)。詳細は js_sandbox_reference ツールで参照できる。';

export const SANDBOX_REFERENCE = `# run_javascript サンドボックス リファレンス

## 実行環境

- QuickJS(ES2023 相当)を WASM で実行する。**Node.js ではない**: \`require\` / \`import\` / \`process\` / \`fs\` / \`path\` / \`os\` / \`child_process\` / \`Buffer\` / npm パッケージは存在しない
- ブラウザでもない: \`window\` / \`document\` / \`XMLHttpRequest\` / \`localStorage\` / \`crypto.subtle\` / \`URL\` は存在しない
- コードは \`(async () => { ... })()\` に包まれて評価される。トップレベル \`await\` 可。\`return\` した値(JSON 化できるもの)が result になる
- 出力は \`console.log / info / debug\`(stdout)と \`console.warn / error\`(stderr)。各 64KB まで
- 制限: メモリ 256MB、時間は \`timeout_ms\`(既定 30 秒、上限 5 分。\`background: true\` なら既定 1 時間、上限 6 時間)、result 32KB
- 権限: ファイルは \`allow_read\` / \`allow_write\`、ネットワークは \`allow_net\` に **呼び出し時に宣言したものだけ**。宣言外は \`permission denied\` で失敗する(宣言して再実行する)

## 使える API

### ファイル(allow_read / allow_write の配下のみ。絶対パス)

- \`await udjat.readFile(path)\` → 文字列(UTF-8)
- \`await udjat.readFile(path, 'base64')\` → base64 文字列 / \`await udjat.readFile(path, 'buffer')\` → \`Uint8Array\`
- \`await udjat.writeFile(path, text)\` / \`await udjat.writeFile(path, uint8array)\`。親フォルダは自動で作らない
- \`await udjat.readDir(path)\` → \`[{ name, type: 'file' | 'dir' | 'other' }]\`

### HTTP(allow_net に host を宣言したものだけ)

- \`const res = await fetch(url, { method, headers, body })\`
  - \`res.status\` / \`res.ok\` / \`res.headers.get('content-type')\` / \`await res.text()\` / \`await res.json()\`
  - \`body\` にオブジェクトを渡すと JSON 文字列にして \`content-type: application/json\` を付ける
  - 応答本文は 2MB まで(\`res.truncated\` が true なら打ち切られている)。バイナリの取得には向かない
- \`await udjat.fetch(url, init)\` → \`{ status, headers, text, truncated }\`(低レベル版)

### バイナリのダウンロード(allow_net に host を宣言したものだけ)

- \`const info = await udjat.download(url, { name?, maxBytes?, saveTo? })\` → \`{ attachment_id, name, mime, size, kind, image_id? / video_id? / pdf_id?, saved_to? }\`
  - 会話の添付として取り込む。**画像はこの呼び出しの結果と一緒にモデルに渡される**(生成結果の確認に使う)
  - 宣言しなければ 5MB まで。大きいファイルは \`allow_download\` に最大バイト数を宣言する(承認が必要)
  - \`saveTo\`(絶対パス)を付けるとフォルダにも保存する(\`allow_write\` の配下のみ)
- 小さいバイナリは \`fetch\` でも受け取れる: \`await res.bytes()\` → \`Uint8Array\`、\`await res.arrayBuffer()\`(2MB まで)

### 待機・ポーリング(推論を挟まずに待てる)

- \`await udjat.sleep(ms)\`
- \`setTimeout(fn, ms)\` / \`clearTimeout(id)\` / \`setInterval(fn, ms)\` / \`clearInterval(id)\`
- 長いポーリングは 1 回の呼び出しの中でループする。例:

\`\`\`js
// ジョブが終わるまで 10 秒ごとに確認する(最大 30 分)
const deadline = Date.now() + 30 * 60 * 1000;
while (Date.now() < deadline) {
  const r = await (await fetch('http://gen.local:7860/status?id=42')).json();
  if (r.state === 'done') return r;
  await udjat.sleep(10_000);
}
throw new Error('timeout');
\`\`\`

- 数十秒を超える処理は \`background: true\` を付けて呼ぶと、バックグラウンドタスクになり完了後に応答が再開される

### 他のツール

- \`await udjat.callTool(name, args)\` → ツールの結果(JSON なら parse 済み、そうでなければ文字列)。エラーは throw
  - 呼べるのは承認ポリシーが「自動で実行」のツールだけ。承認が必要なツール(既定の fs_write など)や run_javascript 自身は呼べない(そのツールを直接呼ぶこと)

### 添付

- \`await udjat.attachments()\` → \`[{ id, name, mime, size, kind }]\`(会話に添付されたファイル。権限宣言は不要)
- \`await udjat.readAttachment(id)\` / \`(id, 'base64')\` / \`(id, 'buffer')\`

### 文字列・バイナリ

- \`udjat.base64.encode(uint8array)\` → 文字列 / \`udjat.base64.decode(str)\` → \`Uint8Array\`
- \`new TextEncoder().encode(str)\` → \`Uint8Array\` / \`new TextDecoder().decode(uint8array)\` → 文字列(UTF-8 のみ)
- \`btoa(str)\` / \`atob(str)\`(Latin-1 の範囲)

## よくある間違いと書き換え

| 書きがちなもの                            | 正しい書き方                                              |
| ----------------------------------------- | --------------------------------------------------------- |
| \`const fs = require('fs')\` / \`import fs from 'fs'\` | \`await udjat.readFile(path)\` / \`await udjat.writeFile(path, data)\` |
| \`fs.readFileSync(path, 'utf8')\`            | \`await udjat.readFile(path)\`                              |
| \`path.join(a, b)\`                          | 文字列連結(\`a + '/' + b\`。Windows は \`\\\\\` でも \`/\` でも可)      |
| \`Buffer.from(str).toString('base64')\`      | \`btoa(str)\` または \`udjat.base64.encode(new TextEncoder().encode(str))\` |
| \`Buffer.from(b64, 'base64')\`               | \`udjat.base64.decode(b64)\`                                |
| \`process.env.X\` / \`process.argv\`           | 使えない。必要な値は引数の code に埋め込む                  |
| \`await new Promise(r => setTimeout(r, ms))\` | そのままでも動くが \`await udjat.sleep(ms)\` が簡潔            |
| \`new URL(u).searchParams\`                  | 使えない。文字列で組み立てる                               |
| \`res.body.getReader()\` / ストリーム         | 使えない。\`await res.text()\` / \`await res.json()\` / \`await res.bytes()\` |
| 画像を fetch して base64 で返す                | \`await udjat.download(url)\`(モデルに画像として届く)          |
| \`XMLHttpRequest\` / \`axios\`                 | \`fetch\`                                                  |
| \`console.log\` の結果が返らない              | 最後に \`return 値\` する(console 出力も stdout として返る)   |
`;

/** コード本文から Node.js / ブラウザ前提の書き方を見つけてヒントにする(実行が失敗した時だけ添える) */
export function staticHints(code: string): string[] {
  const hints: string[] = [];
  const has = (re: RegExp) => re.test(code);
  if (has(/\brequire\s*\(/) || has(/\bimport\s*\(/) || has(/^\s*import\s.+\sfrom\s/m))
    hints.push(
      'require / import は使えません(モジュールは無い)。ファイルは udjat.readFile / udjat.writeFile、HTTP は fetch を使う',
    );
  if (
    has(
      /\bfs\.(readFile|writeFile|readFileSync|writeFileSync|existsSync|statSync|mkdirSync|promises)/,
    )
  )
    hints.push(
      'fs は無い。udjat.readFile(path) / udjat.writeFile(path, data) を使う(allow_read / allow_write の宣言が必要)',
    );
  if (has(/\.blob\s*\(\)/) || has(/\bFileReader\b/) || has(/\bBlob\b/))
    hints.push(
      'Blob / FileReader は無い。バイナリの取得は udjat.download(url) を使う(添付として取り込まれ、画像はそのまま見える)。小さいものは await res.bytes()',
    );
  if (has(/\bprocess\.(env|argv|cwd|platform)/))
    hints.push('process は無い。必要な値はコードに直接書く');
  if (has(/\bBuffer\.(from|alloc)/))
    hints.push('Buffer は無い。udjat.base64.encode / decode、TextEncoder / TextDecoder を使う');
  if (has(/(^|[^A-Za-z0-9_])\/tmp\//) || has(/~\//))
    hints.push('/tmp や ~ は無い(Windows)。許可フォルダの絶対パスを使う');
  if (has(/\bnew\s+URL\s*\(/) || has(/\bURLSearchParams\b/))
    hints.push('URL / URLSearchParams は無い。文字列で組み立てる');
  return hints;
}

/** ReferenceError の名前から、対応する書き方のヒントを返す(無ければ null) */
export function referenceHint(error: string): string | null {
  const m = /ReferenceError: '?([A-Za-z_$][\w$]*)'? is not defined/.exec(error);
  if (!m) return null;
  const name = m[1]!;
  const hints: Record<string, string> = {
    require:
      'require / import は使えません。ファイルは udjat.readFile / udjat.writeFile、HTTP は fetch を使ってください',
    module: 'CommonJS / ESM のモジュールはありません。return で結果を返してください',
    exports: 'CommonJS / ESM のモジュールはありません。return で結果を返してください',
    process:
      'process はありません(Node.js ではなく QuickJS です)。必要な値はコードに埋め込んでください',
    Buffer:
      'Buffer はありません。udjat.base64.encode / decode、TextEncoder / TextDecoder、btoa / atob を使ってください',
    fs: 'fs はありません。udjat.readFile / udjat.writeFile / udjat.readDir を使ってください(allow_read / allow_write の宣言が必要)',
    path: 'path はありません。文字列連結でパスを組み立ててください',
    __dirname: '__dirname / __filename はありません。絶対パスを使ってください',
    __filename: '__dirname / __filename はありません。絶対パスを使ってください',
    XMLHttpRequest: 'XMLHttpRequest はありません。fetch を使ってください',
    axios: 'npm パッケージは使えません。fetch を使ってください',
    URL: 'URL はありません。文字列で組み立ててください',
    URLSearchParams: 'URLSearchParams はありません。文字列で組み立ててください',
    crypto: 'crypto はありません(ハッシュや乱数が必要なら Math.random か簡易実装で)',
    document: 'DOM はありません(ブラウザではなく QuickJS です)',
    window: 'DOM はありません(ブラウザではなく QuickJS です)',
    localStorage: 'localStorage はありません。必要なら udjat.writeFile で保存してください',
  };
  const hint = hints[name];
  if (!hint) return null;
  return `${hint}。詳しくは js_sandbox_reference ツールを参照`;
}

/** QuickJS の "TypeError: not a function"(名前が出ない)向けの汎用ヒント */
export function typeErrorHint(error: string): string | null {
  if (!/TypeError: (not a function|.* is not a function)/.test(error)) return null;
  return '存在しない関数を呼んでいます。ブラウザ / Node.js 固有の API(res.blob().arrayBuffer 以外の Blob 操作、FileReader、fs.*、path.* など)は無いので、js_sandbox_reference ツールで使える API を確認してください';
}

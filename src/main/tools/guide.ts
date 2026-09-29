import { platform } from 'node:os';
import type { ToolDefinition } from '@main/providers';
import { readRoots } from './builtin/files';

/**
 * ツール利用の手引き(system プロンプトに付ける短い箇条書き)。
 * ローカルモデルはツールの説明文を読み飛ばしがちなので、要点だけを system に置く(設定 tools.systemGuide)。
 * 実際のログで起きた失敗(Node 前提のコード、await 忘れ、POSIX パス、fetch でのバイナリ取得)に絞る。
 */
export function buildToolGuide(
  tools: ToolDefinition[],
  getSetting: (key: string) => unknown,
): string | null {
  if (tools.length === 0) return null;
  const names = new Set(tools.map((t) => t.name));
  const lines: string[] = [];
  const win = platform() === 'win32';
  lines.push(
    `- 実行環境は ${win ? 'Windows' : platform()}。ファイルパスは絶対パス${win ? '(例: C:\\\\Users\\\\name\\\\folder\\\\file.txt。/tmp や ~ は無い)' : ''}`,
  );
  const roots = readRoots(getSetting);
  if (roots.length > 0)
    lines.push(
      `- ファイルの読み書きに使える許可フォルダ: ${roots.map((r) => `${r.path}${r.write ? '(書込可)' : '(読取のみ)'}`).join(', ')}`,
    );
  if (names.has('fs_read') || names.has('fs_list'))
    lines.push('- ファイルを読む・一覧するなら fs_read / fs_list を使う(コードを書く必要はない)');
  if (names.has('attachment_save'))
    lines.push(
      '- ダウンロードや生成で得た添付をユーザーの手元に置くには attachment_save(attachment_id, path) で許可フォルダに保存し、保存先を伝える',
    );
  lines.push(
    '- 会話に添付されたファイルの中身はすでに見えている(テキストは本文、画像は画像として)。改めて読みに行く必要はない',
  );
  if (names.has('run_javascript')) {
    lines.push(
      '- run_javascript は QuickJS のサンドボックス(Node.js でもブラウザでもない): require / import / process / fs / Buffer / Blob / FileReader / npm は無い。' +
        'ファイルは udjat.readFile / udjat.writeFile、HTTP は fetch(res.json() / res.text() / res.bytes())。' +
        '結果は最後に return で返す(関数を呼ぶだけでは値が返らない)。' +
        'URL に触るコードは allow_net にホストを、ファイルに触るコードは allow_read / allow_write に絶対パスを必ず宣言する',
    );
    lines.push(
      '- 画像・動画・PDF などのバイナリを受け取るには udjat.download(url)' +
        (names.has('web_download') ? ' か web_download ツール' : '') +
        ' を使う(添付として取り込まれ、画像はそのまま見える)。fetch で本文を取って保存しようとしない',
    );
    lines.push(
      '- ジョブの完了待ちなど長い処理は、1 回の run_javascript の中で udjat.sleep(ms) を使ってポーリングし、background: true を付ける(何度も状態確認のツールを呼ばない)',
    );
    if (names.has('js_sandbox_reference'))
      lines.push('- run_javascript の詳しい API は js_sandbox_reference ツールで確認できる');
  } else if (names.has('web_download')) {
    lines.push('- 画像・動画・PDF などのバイナリを受け取るには web_download ツールを使う');
  }
  return `# ツール利用の手引き\n${lines.join('\n')}`;
}

import type { Attachment, Conversation, Message, ToolMeta } from '@shared/schemas';

/**
 * 会話のエクスポート。
 * - Markdown: 表示中のパス(root -> 葉)を人が読める形に
 * - JSON: 会話全体の木(全メッセージ)と添付メタ
 */

function partsText(m: Message): string {
  return m.parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

function attachmentsText(m: Message): string[] {
  return m.parts
    .filter((p) => p.type !== 'text' && p.type !== 'reasoning')
    .map(
      (p) =>
        `[添付${{ image: '画像', video: '動画', audio: '音声', file: 'ファイル' }[p.type as 'image' | 'video' | 'audio' | 'file']}: ${p.name ?? p.attachmentId}]`,
    );
}

export function exportMarkdown(conversation: Conversation, path: Message[]): string {
  const lines: string[] = [];
  lines.push(`# ${conversation.title || '(無題)'}`);
  lines.push('');
  lines.push(`- 作成: ${new Date(conversation.createdAt).toLocaleString('ja-JP')}`);
  if (conversation.model) lines.push(`- モデル: ${conversation.model}`);
  if (conversation.systemPrompt) {
    lines.push('');
    lines.push('## システムプロンプト');
    lines.push('');
    lines.push(conversation.systemPrompt);
  }
  lines.push('');
  for (const m of path) {
    if (m.kind === 'note') {
      lines.push(`> ${partsText(m)}`);
      lines.push('');
      continue;
    }
    if (m.role === 'tool') {
      const meta = m.toolMeta as ToolMeta | null;
      lines.push(
        `<details><summary>ツール結果: ${meta?.name ?? 'tool'}${meta?.isError ? ' (エラー)' : ''}</summary>`,
      );
      lines.push('');
      lines.push('```');
      lines.push(partsText(m));
      lines.push('```');
      lines.push('</details>');
      lines.push('');
      continue;
    }
    if (m.kind === 'compaction') {
      lines.push('## 要約(ここまでの会話を圧縮)');
      lines.push('');
      lines.push(partsText(m));
      lines.push('');
      continue;
    }
    if (m.kind === 'tool-media') {
      lines.push(
        `_(ツールが返した画像 ${m.parts.filter((p) => p.type === 'image' || p.type === 'video').length} 件をモデルに送信)_`,
      );
      lines.push('');
      continue;
    }
    lines.push(`## ${m.role === 'user' ? 'ユーザー' : 'アシスタント'}`);
    lines.push('');
    const reasoning = m.parts
      .filter((p) => p.type === 'reasoning')
      .map((p) => p.text)
      .join('\n');
    if (reasoning) {
      lines.push('<details><summary>思考過程</summary>');
      lines.push('');
      lines.push(reasoning);
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }
    const text = partsText(m);
    if (text) {
      lines.push(text);
      lines.push('');
    }
    for (const a of attachmentsText(m)) lines.push(a);
    if (m.toolCalls && m.toolCalls.length > 0) {
      for (const c of m.toolCalls) lines.push(`- ツール呼び出し: \`${c.name}\` ${c.args}`);
      lines.push('');
    }
    if (m.error) {
      lines.push(`> エラー: ${m.error}`);
      lines.push('');
    }
  }
  return (
    lines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim() + '\n'
  );
}

export function exportJson(
  conversation: Conversation,
  messages: Message[],
  attachments: Attachment[],
): string {
  return JSON.stringify(
    {
      format: 'udjat-conversation',
      version: 1,
      exportedAt: new Date().toISOString(),
      conversation,
      messages,
      attachments: attachments.map((a) => ({ ...a, refCount: undefined })),
    },
    null,
    2,
  );
}

export function exportFileName(conversation: Conversation, ext: 'md' | 'json'): string {
  const base = (conversation.title || 'conversation')
    .replace(/[\\/:*?"<>|\r\n]/g, '_')
    .slice(0, 60);
  const d = new Date(conversation.createdAt);
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `${stamp}-${base}.${ext}`;
}

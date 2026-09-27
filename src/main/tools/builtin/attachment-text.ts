import { promises as fs } from 'node:fs';
import type { MediaStore } from '@main/media/store';
import { looksText } from '@main/media/text-files';
import type { RegisteredTool } from '../types';
import { fail, num, ok, str } from '../types';

/**
 * attachment_text: 添付されたテキスト系ファイルの続きを読む(M13)。
 * 添付時は先頭だけを展開して送るので、大きなファイルはこのツールで範囲を指定して読む。
 */

const DEFAULT_MAX_CHARS = 20_000;
const MAX_CHARS = 200_000;
const MAX_BYTES = 32 * 1024 * 1024;

export function createAttachmentTextTool(store: MediaStore): RegisteredTool {
  return {
    definition: {
      name: 'attachment_text',
      description:
        '会話に添付されたテキスト系ファイル(attachment_id で指定)の本文を offset / max_chars で範囲指定して読む。' +
        '添付時に先頭しか展開されなかった大きなファイルの続きを読む時に使う。PDF は pdf_text、画像は添付時に見えている。',
      parameters: {
        type: 'object',
        properties: {
          attachment_id: { type: 'string', description: '添付の attachment_id' },
          offset: { type: 'integer', description: '読み始め位置(文字。既定 0)', minimum: 0 },
          max_chars: {
            type: 'integer',
            description: `返す最大文字数(既定 ${DEFAULT_MAX_CHARS}、上限 ${MAX_CHARS})`,
            minimum: 100,
            maximum: MAX_CHARS,
          },
        },
        required: ['attachment_id'],
        additionalProperties: false,
      },
    },
    source: { kind: 'builtin' },
    category: 'basic',
    defaultPolicy: 'auto',
    execute: async (args) => {
      const id = str(args, 'attachment_id');
      const a = store.get(id);
      if (!a)
        return fail(
          `attachment_id ${id} は存在しません。添付の注記にある attachment_id を使ってください`,
        );
      if (a.mime === 'application/pdf') return fail(`${id} は PDF です。pdf_text を使ってください`);
      if (a.size > MAX_BYTES) return fail(`大きすぎます(${a.size} バイト、上限 ${MAX_BYTES})`);
      const buf = await fs.readFile(store.pathOf(a));
      if (!looksText(a.mime, a.originalName, buf.subarray(0, 8192)))
        return fail(`${a.originalName} はテキストではありません (${a.mime})`);
      const maxChars = Math.floor(num(args, 'max_chars', DEFAULT_MAX_CHARS, 100, MAX_CHARS));
      const offset = Math.floor(num(args, 'offset', 0, 0));
      const full = buf.toString('utf8');
      const text = full.slice(offset, offset + maxChars);
      const truncated = offset + text.length < full.length;
      return ok(
        JSON.stringify({
          attachment_id: a.id,
          name: a.originalName,
          total_chars: full.length,
          offset,
          text,
          ...(truncated ? { truncated: true, next_offset: offset + text.length } : {}),
        }),
      );
    },
  };
}

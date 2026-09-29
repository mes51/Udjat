import { promises as fs } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import type { MediaStore } from '@main/media/store';
import type { RegisteredTool } from '../types';
import { fail, ok, str } from '../types';
import { checkPath, readRoots } from './files';

/**
 * attachment_save: 会話の添付(web_download / udjat.download / fs_read で取り込んだものや、ユーザーが付けたもの)を
 * 許可フォルダ(書き込み可)配下のパスに書き出す(M20)。ユーザーが生成物を手元で確認できるようにする。
 */
export function createAttachmentSaveTool(
  store: MediaStore,
  getSetting: (key: string) => unknown,
): RegisteredTool {
  return {
    definition: {
      name: 'attachment_save',
      description:
        '会話の添付(attachment_id / image_id / video_id / pdf_id)を、書き込み可の許可フォルダ配下のパスにファイルとして保存する。' +
        'ダウンロードした生成結果などをユーザーが開ける場所に置きたい時に使う。保存先は絶対パス(フォルダを指定した場合は元の名前で保存)。',
      parameters: {
        type: 'object',
        properties: {
          attachment_id: { type: 'string', description: '添付の id' },
          path: {
            type: 'string',
            description:
              '保存先の絶対パス(ファイル名まで、またはフォルダ)。親フォルダは無ければ作る',
          },
          overwrite: { type: 'boolean', description: '既存のファイルを上書きする(既定 false)' },
        },
        required: ['attachment_id', 'path'],
        additionalProperties: false,
      },
    },
    source: { kind: 'builtin' },
    category: 'files',
    defaultPolicy: 'ask',
    unavailable: () =>
      readRoots(getSetting).some((r) => r.write)
        ? null
        : '書き込み可の許可フォルダが未設定です(設定 > ツール > ファイル で追加すると使えます)',
    execute: async (args) => {
      const id = str(args, 'attachment_id');
      const a = store.get(id);
      if (!a) return fail(`attachment_id ${id} は存在しません`);
      const raw = str(args, 'path');
      if (!isAbsolute(raw)) return fail(`path は絶対パスで指定してください: ${raw}`);
      let target = await checkPath(raw, readRoots(getSetting), 'write');
      const st = await fs.stat(target).catch(() => null);
      if (st?.isDirectory() || /[\\/]$/.test(raw)) {
        target = await checkPath(
          `${target.replace(/[\\/]$/, '')}\\${a.originalName}`,
          readRoots(getSetting),
          'write',
        );
      }
      const exists = await fs.stat(target).catch(() => null);
      if (exists && args['overwrite'] !== true)
        return fail(`既に存在します: ${target}(上書きするなら overwrite: true)`);
      await fs.mkdir(dirname(target), { recursive: true });
      await fs.copyFile(store.pathOf(a), target);
      return ok(
        JSON.stringify({ saved_to: target, name: a.originalName, size: a.size, mime: a.mime }),
      );
    },
  };
}

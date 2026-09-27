import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type Database } from '@main/db/client';
import { AttachmentRepository } from '@main/db/repositories/attachments';
import { FfmpegService } from '@main/media/ffmpeg';
import { MediaStore } from '@main/media/store';
import { VideoOps } from '@main/media/video-ops';
import { guessFromModelName } from '@main/providers';
import { createAttachmentTextTool } from '@main/tools/builtin/attachment-text';
import type { ToolContext } from '@main/tools/types';
import { MediaResolver } from './media-resolver';

/**
 * M13: テキスト系の添付は本文を展開して送る(以前は「[添付ファイル: 名前]」だけだった)。
 */

let dir: string;
let db: Database;
let store: MediaStore;
let resolver: MediaResolver;
const caps = guessFromModelName('llamacpp', 'gemma-4');
const ctx: ToolContext = {
  conversationId: 'c',
  runId: 'r',
  signal: new AbortController().signal,
  counters: new Map(),
  getSetting: () => null,
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'udjat-textatt-'));
  db = openDatabase({ path: ':memory:' });
  const ffmpeg = new FfmpegService();
  store = new MediaStore(new AttachmentRepository(db), ffmpeg, {
    mediaDir: join(dir, 'media'),
    cacheDir: join(dir, 'cache'),
  });
  resolver = new MediaResolver(store, new VideoOps(store, ffmpeg), { fileMaxChars: 50 });
  writeFileSync(join(dir, 'API.md'), '# API\n\n' + 'endpoint line\n'.repeat(20));
  writeFileSync(join(dir, 'short.txt'), 'hello attachment');
  writeFileSync(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 0, 7]));
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('text attachments', () => {
  it('inlines short text files with an attachment note', async () => {
    const a = await store.addFile(join(dir, 'short.txt'));
    const r = await resolver.resolve({ type: 'file', attachmentId: a.id, name: 'short.txt' }, caps);
    expect(r.text).toContain(`attachment_id=${a.id}`);
    expect(r.text).toContain('name="short.txt"');
    expect(r.text).toContain('hello attachment');
    expect(r.text).not.toContain('truncated');
  });

  it('truncates long text files and points to attachment_text', async () => {
    const a = await store.addFile(join(dir, 'API.md'));
    expect(a.mime).toBe('text/markdown');
    const r = await resolver.resolve({ type: 'file', attachmentId: a.id, name: 'API.md' }, caps);
    expect(r.text).toContain('first 50 shown');
    expect(r.text).toContain('# API');
    expect(r.text).toContain(`attachment_text(attachment_id="${a.id}", offset=50)`);

    const tool = createAttachmentTextTool(store);
    const t = JSON.parse(
      (await tool.execute({ attachment_id: a.id, offset: 50, max_chars: 100 }, ctx)).text,
    );
    expect(t.offset).toBe(50);
    expect(t.text.length).toBe(100);
    expect(t.truncated).toBe(true);
    expect(t.next_offset).toBe(150);
    const rest = JSON.parse((await tool.execute({ attachment_id: a.id, offset: 150 }, ctx)).text);
    expect(rest.truncated).toBeUndefined();
    expect(50 + 100 + rest.text.length).toBe(t.total_chars);
  });

  it('does not inline binary files', async () => {
    const a = await store.addFile(join(dir, 'blob.bin'));
    const r = await resolver.resolve({ type: 'file', attachmentId: a.id, name: 'blob.bin' }, caps);
    expect(r.text).toContain('binary or too large');
    expect(r.text).toContain('7 bytes');
    const tool = createAttachmentTextTool(store);
    const t = await tool.execute({ attachment_id: a.id }, ctx);
    expect(t.isError).toBe(true);
  });
});

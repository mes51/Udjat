import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type Database } from '@main/db/client';
import { AttachmentRepository } from '@main/db/repositories/attachments';
import { FfmpegService } from '@main/media/ffmpeg';
import { MediaStore } from '@main/media/store';
import type { ToolContext } from '../types';
import { createAttachmentSaveTool } from './attachment-save';

let dir: string;
let db: Database;
let store: MediaStore;
let settings: Record<string, unknown> = {};
const ctx: ToolContext = {
  conversationId: 'c',
  runId: 'r',
  signal: new AbortController().signal,
  counters: new Map(),
  getSetting: (k) => settings[k] ?? null,
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'udjat-attsave-'));
  db = openDatabase({ path: ':memory:' });
  store = new MediaStore(new AttachmentRepository(db), new FfmpegService(), {
    mediaDir: join(dir, 'media'),
    cacheDir: join(dir, 'cache'),
  });
  writeFileSync(join(dir, 'result.txt'), 'generated');
  settings = { 'fs.roots': [{ path: join(dir, 'out'), write: true }] };
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('attachment_save', () => {
  it('copies an attachment into a write root, to a file or a folder, and refuses overwrite by default', async () => {
    const a = await store.addFile(join(dir, 'result.txt'));
    const tool = createAttachmentSaveTool(store, ctx.getSetting);
    expect(tool.unavailable?.()).toBeNull();
    const r = JSON.parse(
      (await tool.execute({ attachment_id: a.id, path: join(dir, 'out', 'a.txt') }, ctx)).text,
    );
    expect(r.saved_to).toBe(join(dir, 'out', 'a.txt'));
    expect(readFileSync(join(dir, 'out', 'a.txt'), 'utf8')).toBe('generated');
    const dup = await tool.execute({ attachment_id: a.id, path: join(dir, 'out', 'a.txt') }, ctx);
    expect(dup.isError).toBe(true);
    const ok = await tool.execute(
      { attachment_id: a.id, path: join(dir, 'out', 'a.txt'), overwrite: true },
      ctx,
    );
    expect(ok.isError).toBeFalsy();
    const folder = JSON.parse(
      (await tool.execute({ attachment_id: a.id, path: join(dir, 'out') }, ctx)).text,
    );
    expect(folder.saved_to).toBe(join(dir, 'out', 'result.txt'));
    expect(existsSync(join(dir, 'out', 'result.txt'))).toBe(true);
    const outside = await tool
      .execute({ attachment_id: a.id, path: join(dir, 'elsewhere.txt') }, ctx)
      .catch((e: Error) => ({ text: `error: ${e.message}`, isError: true }));
    expect(outside.isError).toBe(true);
    expect(createAttachmentSaveTool(store, () => null).unavailable?.()).toMatch(/許可フォルダ/);
  });
});

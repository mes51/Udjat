import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type Database } from '@main/db/client';
import { AttachmentRepository } from '@main/db/repositories/attachments';
import { FfmpegService } from '@main/media/ffmpeg';
import { MediaStore } from '@main/media/store';
import type { RegisteredTool, ToolContext } from '../types';
import { checkPath, createFileTools, globToRegExp, readRoots } from './files';

let dir: string;
let root: string;
let ro: string;
let db: Database;
let store: MediaStore;
let tools: Record<string, RegisteredTool>;
let settings: Record<string, unknown> = {};

const ctx: ToolContext = {
  conversationId: 'c1',
  runId: 'r',
  signal: new AbortController().signal,
  counters: new Map(),
  getSetting: (k) => settings[k] ?? null,
};

// 1x1 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'udjat-files-'));
  root = join(dir, 'work');
  ro = join(dir, 'readonly');
  mkdirSync(join(root, 'sub', 'deep'), { recursive: true });
  mkdirSync(ro, { recursive: true });
  writeFileSync(join(root, 'a.txt'), 'hello\nworld\n');
  writeFileSync(join(root, 'sub', 'b.json'), '{"x":1}');
  writeFileSync(join(root, 'sub', 'deep', 'c.md'), '# c');
  writeFileSync(join(root, 'img.png'), PNG);
  writeFileSync(join(root, 'bin.dat'), Buffer.from([0, 1, 2, 3, 255]));
  writeFileSync(join(ro, 'r.txt'), 'readonly');
  db = openDatabase({ path: ':memory:' });
  store = new MediaStore(new AttachmentRepository(db), new FfmpegService(), {
    mediaDir: join(dir, 'media'),
    cacheDir: join(dir, 'cache'),
  });
  settings = {
    'fs.roots': [
      { path: root, write: true },
      { path: ro, write: false },
    ],
  };
  tools = Object.fromEntries(
    createFileTools({ store, getSetting: ctx.getSetting }).map((t) => [t.definition.name, t]),
  );
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

// ToolRegistry.execute と同じく、例外は isError の結果にする
const run = async (name: string, args: Record<string, unknown>) => {
  try {
    return await tools[name]!.execute(args, ctx);
  } catch (e) {
    return { text: `error: ${(e as Error).message}`, isError: true };
  }
};
const parse = (text: string) => JSON.parse(text) as Record<string, unknown>;

describe('roots / path checks', () => {
  it('reads roots from settings and drops broken entries', () => {
    expect(readRoots(() => [{ path: root, write: true }, { path: 'rel' }, 'x', null])).toEqual([
      { path: root, write: true },
    ]);
    expect(readRoots(() => null)).toEqual([]);
  });

  it('allows paths under roots and rejects escapes', async () => {
    const roots = readRoots(ctx.getSetting);
    await expect(checkPath(join(root, 'a.txt'), roots, 'read')).resolves.toBeTruthy();
    await expect(checkPath(join(ro, 'r.txt'), roots, 'read')).resolves.toBeTruthy();
    await expect(checkPath(join(ro, 'r.txt'), roots, 'write')).rejects.toThrow(
      /書き込みが許可されていない/,
    );
    await expect(checkPath(join(dir, 'other.txt'), roots, 'read')).rejects.toThrow(
      /許可されていない/,
    );
    await expect(checkPath(join(root, '..', 'other.txt'), roots, 'read')).rejects.toThrow();
    await expect(checkPath('relative/x.txt', roots, 'read')).rejects.toThrow(/絶対パス/);
    // まだ存在しないファイル(書き込み先)も配下なら通る
    await expect(checkPath(join(root, 'new', 'file.txt'), roots, 'write')).resolves.toBeTruthy();
  });

  it('marks tools unavailable when no roots are configured', () => {
    const t = createFileTools({ store, getSetting: () => null });
    expect(t[0]!.unavailable?.()).toMatch(/許可フォルダ/);
    expect(tools['fs_list']!.unavailable?.()).toBeNull();
    expect(tools['fs_list']!.definition.description).toContain(root);
  });

  it('converts globs', () => {
    expect(globToRegExp('*.png').test('a.png')).toBe(true);
    expect(globToRegExp('*.png').test('sub/a.png')).toBe(false);
    expect(globToRegExp('**/*.png').test('sub/deep/a.png')).toBe(true);
    expect(globToRegExp('**/*.png').test('a.png')).toBe(true);
    expect(globToRegExp('sub/?.json').test('sub/b.json')).toBe(true);
    expect(globToRegExp('a.b').test('aXb')).toBe(false);
  });
});

describe('fs_list', () => {
  it('lists a directory', async () => {
    const r = parse((await run('fs_list', { path: root })).text);
    const names = (r['entries'] as { path: string; type: string }[]).map(
      (e) => `${e.type}:${e.path}`,
    );
    expect(names).toEqual(['file:a.txt', 'file:bin.dat', 'file:img.png', 'dir:sub']);
  });

  it('walks recursively with a pattern and sorts by mtime', async () => {
    const r = parse(
      (await run('fs_list', { path: root, recursive: true, pattern: '**/*.md' })).text,
    );
    expect((r['entries'] as { path: string }[]).map((e) => e.path)).toEqual(['sub/deep/c.md']);
    const all = parse(
      (
        await run('fs_list', {
          path: root,
          recursive: true,
          sort: 'mtime',
          newest_first: true,
          max_entries: 2,
        })
      ).text,
    );
    expect((all['entries'] as unknown[]).length).toBe(2);
    expect(all['truncated']).toBe(true);
    expect(all['total']).toBe(7);
  });

  it('rejects paths outside roots', async () => {
    const r = await run('fs_list', { path: dir });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/許可されていない/);
  });
});

describe('fs_read', () => {
  it('reads text with offset / max_chars', async () => {
    const r = parse((await run('fs_read', { path: join(root, 'a.txt') })).text);
    expect(r['text']).toBe('hello\nworld\n');
    expect(r['truncated']).toBeUndefined();
    const part = parse(
      (await run('fs_read', { path: join(root, 'a.txt'), max_chars: 100, offset: 6 })).text,
    );
    expect(part['text']).toBe('world\n');
  });

  it('truncates long text and reports next_offset', async () => {
    writeFileSync(join(root, 'long.txt'), 'x'.repeat(500));
    const r = parse((await run('fs_read', { path: join(root, 'long.txt'), max_chars: 100 })).text);
    expect((r['text'] as string).length).toBe(100);
    expect(r['truncated']).toBe(true);
    expect(r['next_offset']).toBe(100);
  });

  it('imports images as media', async () => {
    const r = await run('fs_read', { path: join(root, 'img.png') });
    expect(r.isError).toBeFalsy();
    expect(r.media?.[0]?.kind).toBe('image');
    const body = parse(r.text);
    expect(body['kind']).toBe('image');
    expect(store.get(body['image_id'] as string)?.originalName).toBe('img.png');
  });

  it('refuses binary unless base64 is requested', async () => {
    const r = await run('fs_read', { path: join(root, 'bin.dat') });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/base64/);
    const b = parse(
      (await run('fs_read', { path: join(root, 'bin.dat'), encoding: 'base64' })).text,
    );
    expect(Buffer.from(b['base64'] as string, 'base64')).toEqual(Buffer.from([0, 1, 2, 3, 255]));
  });

  it('reads from read-only roots', async () => {
    const r = parse((await run('fs_read', { path: join(ro, 'r.txt') })).text);
    expect(r['text']).toBe('readonly');
  });
});

describe('fs_write', () => {
  it('writes, creating parent folders', async () => {
    const p = join(root, 'out', 'nested', 'n.txt');
    const r = parse((await run('fs_write', { path: p, content: 'abc' })).text);
    expect(r['created']).toBe(true);
    expect(readFileSync(p, 'utf8')).toBe('abc');
  });

  it('appends and honours create mode', async () => {
    const p = join(root, 'app.txt');
    await run('fs_write', { path: p, content: 'a' });
    await run('fs_write', { path: p, content: 'b', mode: 'append' });
    expect(readFileSync(p, 'utf8')).toBe('ab');
    const dup = await run('fs_write', { path: p, content: 'c', mode: 'create' });
    expect(dup.isError).toBe(true);
  });

  it('writes base64', async () => {
    const p = join(root, 'copy.png');
    await run('fs_write', { path: p, content: PNG.toString('base64'), encoding: 'base64' });
    expect(readFileSync(p)).toEqual(PNG);
  });

  it('rejects read-only roots and outside paths', async () => {
    const r = await run('fs_write', { path: join(ro, 'x.txt'), content: 'x' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/書き込みが許可されていない/);
    const o = await run('fs_write', { path: join(dir, 'x.txt'), content: 'x' });
    expect(o.isError).toBe(true);
  });
});

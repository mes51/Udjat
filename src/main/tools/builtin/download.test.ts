import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type Database } from '@main/db/client';
import { AttachmentRepository } from '@main/db/repositories/attachments';
import { FfmpegService } from '@main/media/ffmpeg';
import { MediaStore } from '@main/media/store';
import { startMockServer, type MockServer } from '@main/providers/test-server';
import type { RegisteredTool, ToolContext } from '../types';
import { createCodeTools } from './code';
import { createDownloadTools, downloadToStore } from './download';

/**
 * M18: バイナリのダウンロード(web_download と udjat.download)。
 */

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);
const BIG = Buffer.alloc(300 * 1024, 7);

let dir: string;
let db: Database;
let store: MediaStore;
let server: MockServer;
let webDownload: RegisteredTool;
let runJs: RegisteredTool;
let settings: Record<string, unknown> = {};

const ctx: ToolContext = {
  conversationId: 'c',
  runId: 'r',
  signal: new AbortController().signal,
  counters: new Map(),
  getSetting: (k) => settings[k] ?? null,
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'udjat-dl-'));
  db = openDatabase({ path: ':memory:' });
  store = new MediaStore(new AttachmentRepository(db), new FfmpegService(), {
    mediaDir: join(dir, 'media'),
    cacheDir: join(dir, 'cache'),
  });
  server = await startMockServer({
    'GET /gen/out.png': (_r, _b, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(PNG.length) });
      res.end(PNG);
    },
    'GET /files/blob': (_r, _b, res) => {
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': 'attachment; filename="result.bin"',
      });
      res.end(Buffer.from([1, 2, 3, 4]));
    },
    'GET /big': (_r, _b, res) => {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(BIG);
    },
    'GET /api/text': (_r, _b, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    },
  });
  const host = new URL(server.url).host;
  settings = {
    'webFetch.allowHosts': [host],
    'fs.roots': [{ path: dir, write: true }],
  };
  webDownload = createDownloadTools({ store })[0]!;
  runJs = createCodeTools({ store })[0]!;
});

afterAll(async () => {
  await server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('downloadToStore', () => {
  it('stores the body as an attachment with a name from Content-Disposition', async () => {
    const d = await downloadToStore(store, `${server.url}/files/blob`, {
      maxBytes: 1024,
      signal: ctx.signal,
      allowHosts: [new URL(server.url).host],
    });
    expect(d.attachment.originalName).toBe('result.bin');
    expect(d.attachment.size).toBe(4);
    expect(readFileSync(store.pathOf(d.attachment))).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it('rejects bodies over the limit and private hosts without allowHosts', async () => {
    await expect(
      downloadToStore(store, `${server.url}/big`, {
        maxBytes: 1000,
        signal: ctx.signal,
        skipGuard: true,
      }),
    ).rejects.toThrow(/サイズ上限/);
    await expect(
      downloadToStore(store, `${server.url}/gen/out.png`, { maxBytes: 1000, signal: ctx.signal }),
    ).rejects.toThrow(/プライベートアドレス/);
  });
});

describe('web_download', () => {
  it('downloads an image, shows it to the model, and can save it to an allowed folder', async () => {
    const saveTo = join(dir, 'out', 'copy.png');
    const r = await webDownload.execute({ url: `${server.url}/gen/out.png`, save_to: saveTo }, ctx);
    expect(r.isError).toBeFalsy();
    const body = JSON.parse(r.text);
    expect(body.kind).toBe('image');
    expect(body.image_id).toBe(body.attachment_id);
    expect(body.saved_to).toBe(saveTo);
    expect(r.media?.[0]).toMatchObject({ attachmentId: body.attachment_id, kind: 'image' });
    expect(readFileSync(saveTo)).toEqual(PNG);
    expect(webDownload.requiresApproval?.({ url: 'x', save_to: saveTo })).toBe(true);
    expect(webDownload.requiresApproval?.({ url: 'x' })).toBe(false);
    expect(webDownload.requiresApproval?.({ url: 'x', max_bytes: 100 * 1024 * 1024 })).toBe(true);
  });

  it('refuses save_to outside the write roots and reports oversize downloads', async () => {
    // ToolRegistry.execute と同じく、例外は isError の結果にする
    const r = await webDownload
      .execute({ url: `${server.url}/files/blob`, save_to: join(tmpdir(), 'elsewhere.bin') }, ctx)
      .catch((e: Error) => ({ text: `error: ${e.message}`, isError: true }));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/書き込みが許可されていない/);
    const big = await webDownload.execute({ url: `${server.url}/big`, max_bytes: 1000 }, ctx);
    expect(big.isError).toBe(true);
    expect(big.text).toMatch(/サイズ上限/);
  });
});

describe('run_javascript downloads', () => {
  it('exposes udjat.download and binary fetch bytes, and returns downloaded images as media', async () => {
    const host = new URL(server.url).host;
    const code = `const info = await udjat.download(${JSON.stringify(`${server.url}/gen/out.png`)}, { name: 'gen.png' });
      const res = await fetch(${JSON.stringify(`${server.url}/files/blob`)});
      const bytes = await res.bytes();
      const j = await (await fetch(${JSON.stringify(`${server.url}/api/text`)})).json();
      return { kind: info.kind, name: info.name, bytes: Array.from(bytes), ok: j.ok };`;
    const r = await runJs.execute({ code, allow_net: [host] }, ctx);
    expect(r.isError).toBeFalsy();
    const payload = JSON.parse(r.text);
    // 同じ内容(sha256)は既存の添付を再利用するので、名前は先に取り込んだ out.png のまま
    expect(payload.result).toEqual({
      kind: 'image',
      name: 'out.png',
      bytes: [1, 2, 3, 4],
      ok: true,
    });
    expect(payload.downloaded_images).toContain('1 枚');
    expect(r.media).toHaveLength(1);
    expect(store.get(r.media![0]!.attachmentId)?.mime).toBe('image/png');
  });

  it('caps downloads at 5MB unless allow_download is declared, and requires approval for it', async () => {
    const host = new URL(server.url).host;
    const small = await runJs.execute(
      {
        code: `return (await udjat.download(${JSON.stringify(`${server.url}/big`)}, { maxBytes: 1000 })).size;`,
        allow_net: [host],
      },
      ctx,
    );
    const payload = JSON.parse(small.text);
    expect(payload.ok).toBe(false);
    expect(payload.error).toMatch(/サイズ上限/);
    const declared = await runJs.execute(
      {
        code: `const d = await udjat.download(${JSON.stringify(`${server.url}/big`)}, { saveTo: ${JSON.stringify(join(dir, 'big.bin'))} }); return d.size;`,
        allow_net: [host],
        allow_download: 1024 * 1024,
        allow_write: [dir],
      },
      ctx,
    );
    expect(JSON.parse(declared.text).result).toBe(BIG.length);
    expect(existsSync(join(dir, 'big.bin'))).toBe(true);
    expect(runJs.requiresApproval?.({ code: 'x', allow_download: 10 })).toBe(true);
    const denied = await runJs.execute(
      {
        code: `await udjat.download(${JSON.stringify(`${server.url}/gen/out.png`)});`,
        allow_net: ['other.example'],
      },
      ctx,
    );
    expect(JSON.parse(denied.text).error).toMatch(/permission denied: download/);
  });
});

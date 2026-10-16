import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Attachment } from '@shared/schemas';
import { MediaResolver } from '@main/chat/media-resolver';
import { openDatabase, type Database } from '@main/db/client';
import { AttachmentRepository } from '@main/db/repositories/attachments';
import { guessFromModelName } from '@main/providers';
import { binariesAvailable, resolveBinaries } from './binaries';
import { FfmpegService } from './ffmpeg';
import { MediaStore } from './store';
import { derivationOf, VideoOps } from './video-ops';

/**
 * 派生物のキャッシュ(M23): ファイルを消したフレーム等を、元動画から同じ指定で作り直せること。
 */

const bins = resolveBinaries();
const available = binariesAvailable(bins);
let dir: string;
let db: Database;
let store: MediaStore;
let ops: VideoOps;
let video: Attachment;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'udjat-videoops-'));
  db = openDatabase({ path: ':memory:' });
  const ffmpeg = new FfmpegService();
  store = new MediaStore(new AttachmentRepository(db), ffmpeg, {
    mediaDir: join(dir, 'media'),
    cacheDir: join(dir, 'cache'),
  });
  ops = new VideoOps(store, ffmpeg);
  store.setRestorer((a) => ops.regenerate(a));
  if (!available.ffmpeg) return;
  const src = join(dir, 'src.mp4');
  await execa(bins.ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=4:size=320x240:rate=10',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    src,
  ]);
  video = await store.addFile(src);
}, 60_000);

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('derivationOf', () => {
  const base = {
    id: 'x',
    sha256: 's',
    mime: 'image/jpeg',
    ext: 'jpg',
    originalName: 'x.jpg',
    size: 1,
    refCount: 0,
    createdAt: 0,
  };
  it('prefers the recorded derivation and infers legacy ones from labels', () => {
    expect(
      derivationOf({
        ...base,
        meta: { kind: 'image', derivedFrom: 'v', derivation: { kind: 'resize', maxEdge: 100 } },
      }),
    ).toEqual({ kind: 'resize', maxEdge: 100 });
    expect(
      derivationOf({
        ...base,
        meta: { kind: 'image', derivedFrom: 'v', timestampMs: 1500, width: 640 },
      }),
    ).toEqual({ kind: 'frame', timestampMs: 1500, width: 640 });
    expect(
      derivationOf({
        ...base,
        meta: {
          kind: 'image',
          derivedFrom: 'v',
          derivedLabel: 'contact-sheet 4x2 0.0s-9.5s',
          width: 1024,
        },
      }),
    ).toEqual({ kind: 'sheet', startMs: 0, endMs: 9500, cols: 4, rows: 2, tileWidth: 256 });
    expect(
      derivationOf({
        ...base,
        meta: {
          kind: 'video',
          derivedFrom: 'v',
          derivedLabel: 'clip 1.0s-3.0s',
          width: 640,
          fps: 2,
        },
      }),
    ).toEqual({ kind: 'clip', startMs: 1000, endMs: 3000, width: 640, fps: 2 });
    expect(derivationOf({ ...base, meta: { kind: 'image', derivedFrom: 'v' } })).toBeNull();
    expect(derivationOf({ ...base, meta: { kind: 'image' } })).toBeNull();
  });
});

describe.skipIf(!available.ffmpeg)('VideoOps regenerate', () => {
  it('records how frames and sheets were made', async () => {
    const [f] = await ops.frames(video, [1000], 160);
    expect(f!.meta.derivation).toEqual({ kind: 'frame', timestampMs: 1000, width: 160 });
    const { sheet } = await ops.contactSheet(video, { cols: 2, rows: 2, tileWidth: 96 });
    expect(sheet.meta.derivation).toMatchObject({ kind: 'sheet', cols: 2, rows: 2, tileWidth: 96 });
  });

  it('restores an evicted frame from the source video when it is read again', async () => {
    const [f] = await ops.frames(video, [2000], 160);
    const path = store.pathOf(f!);
    expect(store.evict(f!)).toBeGreaterThan(0);
    expect(existsSync(path)).toBe(false);
    // 読み出しで作り直される(同じ内容なら sha256 も一致する)
    const b64 = await store.readBase64(f!);
    expect(existsSync(path)).toBe(true);
    expect(b64.length).toBeGreaterThan(100);
    // 同じ指定で frames() を呼んでも、消してあったファイルが戻る
    store.evict(f!);
    const [again] = await ops.frames(video, [2000], 160);
    expect(again!.id).toBe(f!.id);
    expect(existsSync(path)).toBe(true);
  }, 30_000);

  it('sends a note instead of failing when a frame cannot be regenerated', async () => {
    const [f] = await ops.frames(video, [3000], 160);
    store.evict(f!);
    // 元動画のファイルも無くなっていると作り直せない
    const srcPath = store.pathOf(video);
    rmSync(srcPath);
    try {
      const resolver = new MediaResolver(store, ops);
      const r = await resolver.resolve(
        { type: 'image', attachmentId: f!.id, name: 'frame @3.0s' },
        guessFromModelName('llamacpp', 'gemma-4'),
      );
      expect(r.image).toBeUndefined();
      expect(r.text).toContain('unavailable');
      expect(r.text).toContain('frame @3.0s');
    } finally {
      // 他のテストのために元動画を戻す
      await execa(bins.ffmpeg, [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=4:size=320x240:rate=10',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        srcPath,
      ]);
    }
  }, 30_000);
});

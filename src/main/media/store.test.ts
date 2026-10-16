import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type Database } from '@main/db/client';
import { AttachmentRepository } from '@main/db/repositories/attachments';
import { binariesAvailable, resolveBinaries } from './binaries';
import { FfmpegService } from './ffmpeg';
import { kindFromMime, MediaStore, mimeFromName } from './store';

const bins = resolveBinaries();
const available = binariesAvailable(bins);
let dir: string;
let db: Database;
let store: MediaStore;
let repo: AttachmentRepository;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'udjat-store-'));
  db = openDatabase({ path: ':memory:' });
  repo = new AttachmentRepository(db);
  store = new MediaStore(repo, new FfmpegService(), {
    mediaDir: join(dir, 'media'),
    cacheDir: join(dir, 'cache'),
  });
  await execa(bins.ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=64x48:rate=1',
    '-frames:v',
    '1',
    join(dir, 'pic.png'),
  ]);
}, 60_000);

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('mime helpers', () => {
  it('maps names and kinds', () => {
    expect(mimeFromName('movie.MP4')).toBe('video/mp4');
    expect(mimeFromName('photo.jpeg')).toBe('image/jpeg');
    expect(mimeFromName('x.unknown')).toBe('application/octet-stream');
    expect(kindFromMime('video/webm')).toBe('video');
    expect(kindFromMime('application/pdf')).toBe('file');
  });
});

describe.skipIf(!available.ffmpeg)('MediaStore', () => {
  it('stores a file by hash, probes metadata and de-duplicates', async () => {
    const a = await store.addFile(join(dir, 'pic.png'));
    expect(a.mime).toBe('image/png');
    expect(a.meta).toMatchObject({ kind: 'image', width: 64, height: 48 });
    expect(existsSync(store.pathOf(a))).toBe(true);
    const again = await store.addFile(join(dir, 'pic.png'), { originalName: 'other.png' });
    expect(again.id).toBe(a.id);
    expect(readdirSync(join(dir, 'media'))).toHaveLength(1);
  });

  it('stores bytes, links to messages and counts references', async () => {
    const b = await store.addBytes(Buffer.from('hello'), 'note.txt', 'text/plain');
    expect(b.meta).toEqual({ kind: 'file' });
    expect(await store.readBase64(b)).toBe(Buffer.from('hello').toString('base64'));
    expect(repo.listUnreferenced().map((x) => x.id)).toContain(b.id);
    db.exec("INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('c', '', 0, 0)");
    db.exec(
      "INSERT INTO messages (id, conversation_id, role, created_at) VALUES ('m', 'c', 'user', 0)",
    );
    repo.link('m', b.id);
    repo.link('m', b.id);
    expect(repo.get(b.id)?.refCount).toBe(1);
    expect(repo.listUnreferenced().map((x) => x.id)).not.toContain(b.id);
    // scratch は取り込み後に消える
    expect(readdirSync(join(dir, 'cache', 'scratch'))).toHaveLength(0);
  });

  it('gc removes old unreferenced attachments and orphan files but keeps linked ones', async () => {
    const old = await store.addBytes(Buffer.from('old-unreferenced'), 'old.txt', 'text/plain');
    const fresh = await store.addBytes(
      Buffer.from('fresh-unreferenced'),
      'fresh.txt',
      'text/plain',
    );
    writeFileSync(join(dir, 'media', 'deadbeef.bin'), 'orphan');
    const now = old.createdAt + 48 * 60 * 60 * 1000;
    // fresh は「今」作られたことにする
    db.prepare('UPDATE attachments SET created_at = ? WHERE id = ?').run(now - 1000, fresh.id);
    const r = store.gc({ now });
    expect(r.deletedAttachments).toBeGreaterThanOrEqual(1);
    expect(store.get(old.id)).toBeNull();
    expect(existsSync(join(dir, 'media', `${old.sha256}.txt`))).toBe(false);
    expect(store.get(fresh.id)).not.toBeNull();
    expect(existsSync(join(dir, 'media', 'deadbeef.bin'))).toBe(false);
    // メッセージに紐づいた添付(前のテストの note.txt)は残る
    expect(repo.listAll().some((a) => a.originalName === 'note.txt')).toBe(true);
  });

  it('evicts derived files as cache and restores them through the restorer (M23)', async () => {
    const src = await store.addFile(join(dir, 'pic.png'));
    const derived = await store.addBytes(Buffer.from('frame-bytes'), 'f.jpg', 'image/jpeg', {
      derivedFrom: src.id,
      derivedLabel: 'frame @1.0s',
      timestampMs: 1000,
      derivation: { kind: 'frame', timestampMs: 1000, width: 320 },
    });
    const plain = await store.addBytes(Buffer.from('not-derived'), 'p.txt', 'text/plain');
    expect(store.isDerived(derived)).toBe(true);
    expect(store.isDerived(plain)).toBe(false);
    // 派生物でないものは消せない
    expect(store.evict(plain)).toBe(0);
    expect(store.evict(derived)).toBe('frame-bytes'.length);
    expect(store.isEvicted(derived)).toBe(true);
    expect(store.get(derived.id)).not.toBeNull();
    expect(store.derivedStats()).toMatchObject({ evicted: 1 });
    // restorer が無ければ読めない
    await expect(store.readBase64(derived)).rejects.toThrow(/作り直せません/);
    // restorer を登録すると作り直して読める(同時要求は 1 回にまとまる)
    let calls = 0;
    store.setRestorer(async (a) => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
      writeFileSync(store.pathOf(a), 'regenerated');
      return true;
    });
    const [x, y] = await Promise.all([store.readBase64(derived), store.readBase64(derived)]);
    expect(calls).toBe(1);
    expect(Buffer.from(x, 'base64').toString()).toBe('regenerated');
    expect(y).toBe(x);
    // 同じ内容を addFile し直すと、消してあったファイルが戻る
    store.evict(derived);
    const p = join(dir, 'again.jpg');
    writeFileSync(p, 'frame-bytes');
    const again = await store.addFile(p, {
      mime: 'image/jpeg',
      derivedFrom: src.id,
      derivation: { kind: 'frame', timestampMs: 1000, width: 320 },
    });
    expect(again.id).toBe(derived.id);
    expect(store.isEvicted(derived)).toBe(false);
    // 上限: 直近 1 時間のものは残し、古いものから消す
    db.prepare('UPDATE attachments SET created_at = ? WHERE id = ?').run(1000, derived.id);
    const trimmed = store.enforceDerivedLimit(1, Date.now());
    expect(trimmed.count).toBe(1);
    expect(store.isEvicted(derived)).toBe(true);
    // 未参照の派生物はレコードごと消える
    expect(store.gcUnreferencedDerived()).toBeGreaterThanOrEqual(1);
    expect(store.get(derived.id)).toBeNull();
    expect(store.get(plain.id)).not.toBeNull();
  });

  it('records probe failures without throwing', async () => {
    const p = join(dir, 'broken.mp4');
    writeFileSync(p, 'not a video');
    const a = await store.addFile(p);
    expect(a.meta.kind).toBe('video');
    expect(a.meta.probeError).toBeTruthy();
  });
});

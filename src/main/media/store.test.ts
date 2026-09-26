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
    expect(store.readBase64(b)).toBe(Buffer.from('hello').toString('base64'));
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

  it('records probe failures without throwing', async () => {
    const p = join(dir, 'broken.mp4');
    writeFileSync(p, 'not a video');
    const a = await store.addFile(p);
    expect(a.meta.kind).toBe('video');
    expect(a.meta.probeError).toBeTruthy();
  });
});

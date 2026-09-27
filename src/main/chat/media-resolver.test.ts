import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type Database } from '@main/db/client';
import { AttachmentRepository } from '@main/db/repositories/attachments';
import { binariesAvailable, resolveBinaries } from '@main/media/binaries';
import { FfmpegService } from '@main/media/ffmpeg';
import { PdfService } from '@main/media/pdf';
import { MediaStore } from '@main/media/store';
import { minimalPdf } from '@main/media/test-fixtures';
import { VideoOps } from '@main/media/video-ops';
import { guessFromModelName } from '@main/providers';
import { createPdfTools } from '@main/tools/builtin/pdf';
import type { ToolContext } from '@main/tools/types';
import { MediaResolver } from './media-resolver';

const bins = resolveBinaries();
const available = binariesAvailable(bins);
let dir: string;
let db: Database;
let store: MediaStore;
let resolver: MediaResolver;
let pdf: PdfService;
let ops: VideoOps;

const ctx: ToolContext = {
  conversationId: 'c',
  runId: 'r',
  signal: new AbortController().signal,
  counters: new Map(),
  getSetting: () => null,
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'udjat-resolver-'));
  db = openDatabase({ path: ':memory:' });
  const ffmpeg = new FfmpegService();
  pdf = new PdfService();
  store = new MediaStore(
    new AttachmentRepository(db),
    ffmpeg,
    { mediaDir: join(dir, 'media'), cacheDir: join(dir, 'cache') },
    pdf,
  );
  ops = new VideoOps(store, ffmpeg);
  resolver = new MediaResolver(store, ops, { pdfMaxChars: 60 }, pdf);
  writeFileSync(join(dir, 'doc.pdf'), minimalPdf([['Alpha page'], ['Beta page'], ['Gamma page']]));
  await execa(bins.ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=4',
    join(dir, 'tone.wav'),
  ]);
}, 60_000);

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!available.ffmpeg)('MediaResolver: PDF and audio', () => {
  it('sends PDF text with a pdf_id note and truncates by page', async () => {
    const a = await store.addFile(join(dir, 'doc.pdf'));
    expect(a.mime).toBe('application/pdf');
    expect(a.meta).toMatchObject({ kind: 'file', pageCount: 3 });
    const r = await resolver.resolve(
      { type: 'file', attachmentId: a.id, name: 'doc.pdf' },
      guessFromModelName('llamacpp', 'gemma-4'),
    );
    expect(r.text).toContain(`pdf_id=${a.id}`);
    expect(r.text).toContain('pages=3');
    expect(r.text).toContain('Alpha page');
    // 60 文字制限なので 2 ページ目以降は省略される
    expect(r.text).toContain('truncated');
    expect(r.text).not.toContain('Gamma page');

    // pdf_text で続きが読める、pdf_pages で画像になる
    const [pdfText, pdfPages] = createPdfTools({ store, pdf });
    const t = await pdfText!.execute({ pdf_id: a.id, pages: '2-3' }, ctx);
    expect(JSON.parse(t.text).pages.map((p: { page: number }) => p.page)).toEqual([2, 3]);
    expect(t.text).toContain('Gamma page');
    const p = await pdfPages!.execute({ pdf_id: a.id, pages: '1', width: 400 }, ctx);
    expect(p.media).toHaveLength(1);
    const img = store.get(p.media![0]!.attachmentId)!;
    expect(img.meta).toMatchObject({ kind: 'image', width: 400, derivedFrom: a.id });
  }, 60_000);

  it('sends audio natively only when the model supports it', async () => {
    const a = await store.addFile(join(dir, 'tone.wav'));
    expect(a.meta).toMatchObject({ kind: 'audio', hasAudio: true });
    const noAudio = await resolver.resolve(
      { type: 'audio', attachmentId: a.id, name: 'tone.wav' },
      guessFromModelName('ollama', 'llama3.1'),
    );
    expect(noAudio.audio).toBeUndefined();
    expect(noAudio.text).toContain('音声入力を扱えません');

    const withAudio = await resolver.resolve(
      { type: 'audio', attachmentId: a.id, name: 'tone.wav' },
      { ...guessFromModelName('llamacpp', 'qwen2.5-omni'), audio: true },
    );
    expect(withAudio.audio?.mime).toBe('audio/mpeg');
    expect(withAudio.audio!.base64.length).toBeGreaterThan(1000);
    expect(withAudio.text).toContain('attached audio');
  }, 60_000);
});

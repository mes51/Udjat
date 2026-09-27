import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { binariesAvailable, resolveBinaries } from './binaries';
import { FfmpegService } from './ffmpeg';

const bins = resolveBinaries();
const available = binariesAvailable(bins);

let dir: string;
let video: string;
let image: string;
const svc = new FfmpegService();

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'udjat-ffmpeg-'));
  video = join(dir, 'test.mp4');
  image = join(dir, 'test.png');
  // 10 秒、10fps、320x240 のテスト動画(3 秒ごとに色が変わる)+ 正弦波の音声
  await execa(bins.ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=10:size=320x240:rate=10',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=10',
    '-vf',
    "drawbox=x=0:y=0:w=iw:h=ih:color=red@1:t=fill:enable='between(t,3,6)'",
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-shortest',
    video,
  ]);
  await execa(bins.ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=size=640x360:rate=1',
    '-frames:v',
    '1',
    image,
  ]);
}, 60_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!available.ffmpeg || !available.ffprobe)('FfmpegService', () => {
  it('probes a video and an image', async () => {
    const v = await svc.probe(video);
    expect(v.kind).toBe('video');
    expect(v.width).toBe(320);
    expect(v.height).toBe(240);
    expect(v.durationMs).toBeGreaterThan(9500);
    expect(v.fps).toBeCloseTo(10, 0);
    expect(v.hasAudio).toBe(true);

    const i = await svc.probe(image);
    expect(i.kind).toBe('image');
    expect(i.width).toBe(640);
    expect(i.durationMs).toBeNull();
  });

  it('extracts a frame at a timestamp with a width limit', async () => {
    const out = join(dir, 'frame.jpg');
    await svc.extractFrame(video, 4000, out, { width: 160 });
    expect(existsSync(out)).toBe(true);
    const p = await svc.probe(out);
    expect(p.width).toBe(160);
  });

  it('resizes an image to a max edge', async () => {
    const out = join(dir, 'resized.jpg');
    await svc.resizeImage(image, out, 200);
    const p = await svc.probe(out);
    expect(p.width).toBe(200);
    expect(p.height).toBeLessThanOrEqual(114);
  });

  it('detects scene changes', async () => {
    const times = await svc.sceneChanges(video, 0.3);
    // 3 秒と 6 秒で色が変わる
    expect(times.some((t) => Math.abs(t - 3000) < 300)).toBe(true);
    expect(times.some((t) => Math.abs(t - 6000) < 300)).toBe(true);
  });

  it('builds a contact sheet and reports tile timestamps', async () => {
    const out = join(dir, 'sheet.jpg');
    const r = await svc.contactSheet(video, out, {
      startMs: 0,
      endMs: 10_000,
      cols: 4,
      rows: 2,
      tileWidth: 120,
    });
    expect(r.timestampsMs).toHaveLength(8);
    expect(r.timestampsMs[0]).toBe(625);
    const p = await svc.probe(out);
    expect(p.width).toBeGreaterThan(4 * 120);
    expect(statSync(out).size).toBeGreaterThan(1000);
  });

  it('clips a segment into a small silent mp4', async () => {
    const out = join(dir, 'clip.mp4');
    await svc.clip(video, out, { startMs: 2000, endMs: 5000, width: 160, fps: 2 });
    const p = await svc.probe(out);
    expect(p.kind).toBe('video');
    expect(p.width).toBe(160);
    expect(p.hasAudio).toBe(false);
    expect(p.durationMs).toBeGreaterThan(2000);
    expect(p.durationMs).toBeLessThan(3600);
  });

  it('transcodes audio to mono 16kHz mp3 with a length cap', async () => {
    const out = join(dir, 'audio.mp3');
    await svc.transcodeAudio(video, out, { maxSeconds: 3 });
    const p = await svc.probe(out);
    expect(p.kind).toBe('audio');
    expect(p.audioCodec).toBe('mp3');
    expect(p.durationMs).toBeGreaterThan(2500);
    expect(p.durationMs).toBeLessThan(3600);
  });

  it('reports ffmpeg failures with stderr', async () => {
    await expect(svc.probe(join(dir, 'missing.mp4'))).rejects.toThrow(/ffprobe failed/);
  });
});

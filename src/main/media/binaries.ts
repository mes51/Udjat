import ffmpegStaticPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { existsSync } from 'node:fs';

/**
 * 同梱 ffmpeg / ffprobe のパス解決。
 * パッケージ後は asar の外(app.asar.unpacked)に置かれるため、パスを読み替える。
 * 設定で明示されたパスがあればそれを優先する(M6 で UI を付ける)。
 */

function unpacked(p: string): string {
  return p.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
}

export function resolveBinaries(
  overrides: { ffmpeg?: string | null; ffprobe?: string | null } = {},
): {
  ffmpeg: string;
  ffprobe: string;
} {
  return {
    ffmpeg: overrides.ffmpeg || unpacked(ffmpegStaticPath ?? 'ffmpeg'),
    ffprobe: overrides.ffprobe || unpacked(ffprobeStatic.path),
  };
}

export function binariesAvailable(bins = resolveBinaries()): { ffmpeg: boolean; ffprobe: boolean } {
  return { ffmpeg: existsSync(bins.ffmpeg), ffprobe: existsSync(bins.ffprobe) };
}

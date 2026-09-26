import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DataDirMode } from '@shared/ipc-schema';

/**
 * データディレクトリの決定ロジック。electron に依存しない純関数(テスト用)。
 *
 * - dev:      開発時(未パッケージ)。リポジトリ直下の .dev-data/
 * - portable: exe の隣に portable.marker または data/ がある。exe 隣の data/
 * - standard: それ以外。OS 標準の userData(%APPDATA%/Udjat 等)
 */

export const PORTABLE_MARKER = 'portable.marker';
export const PORTABLE_DATA_DIRNAME = 'data';
export const DEV_DATA_DIRNAME = '.dev-data';

export interface DataDirProbe {
  /** app.isPackaged */
  isPackaged: boolean;
  /** exe のあるディレクトリ(dirname(process.execPath)) */
  exeDir: string;
  /** electron-builder の portable ターゲットが設定する環境変数。zip 配布では未設定 */
  portableExecutableDir?: string | undefined;
  /** app.getPath('userData') の既定値 */
  defaultUserData: string;
  /** 開発時のリポジトリルート */
  devRoot: string;
  /** ファイル存在チェック(テストで差し替える) */
  exists?: (p: string) => boolean;
}

export interface DataDirInfo {
  mode: DataDirMode;
  root: string;
}

export function detectDataDir(probe: DataDirProbe): DataDirInfo {
  const exists = probe.exists ?? existsSync;

  if (!probe.isPackaged) {
    return { mode: 'dev', root: join(probe.devRoot, DEV_DATA_DIRNAME) };
  }

  const baseDir = probe.portableExecutableDir ?? probe.exeDir;
  const markerPath = join(baseDir, PORTABLE_MARKER);
  const dataPath = join(baseDir, PORTABLE_DATA_DIRNAME);
  if (exists(markerPath) || exists(dataPath)) {
    return { mode: 'portable', root: dataPath };
  }

  return { mode: 'standard', root: probe.defaultUserData };
}

/** データディレクトリ配下の固定レイアウト */
export function dataDirLayout(root: string) {
  return {
    root,
    database: join(root, 'udjat.sqlite'),
    media: join(root, 'media'),
    cache: join(root, 'cache'),
    logs: join(root, 'logs'),
    session: join(root, 'session'),
  } as const;
}

export type DataDirLayout = ReturnType<typeof dataDirLayout>;

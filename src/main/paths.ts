import { app } from 'electron';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { dataDirLayout, detectDataDir, type DataDirInfo, type DataDirLayout } from './data-dir';

export interface ResolvedPaths extends DataDirLayout {
  mode: DataDirInfo['mode'];
}

let resolved: ResolvedPaths | null = null;

/**
 * データディレクトリを決定して Electron のパスを差し替える。
 * app.whenReady() より前に一度だけ呼ぶこと(userData を後から動かすと
 * セッション・キャッシュが元の場所に作られてしまう)。
 */
export function initPaths(): ResolvedPaths {
  if (resolved) return resolved;

  const info = detectDataDir({
    isPackaged: app.isPackaged,
    exeDir: dirname(process.execPath),
    portableExecutableDir: process.env['PORTABLE_EXECUTABLE_DIR'],
    // app.getPath('userData') は呼ぶだけで %APPDATA%/<name> を作ることがあるため、
    // ポータブルモードで痕跡を残さないよう appData + name から自前で組み立てる。
    defaultUserData: join(app.getPath('appData'), app.getName()),
    // 開発時: out/main/index.js から見たリポジトリルート
    devRoot: resolve(app.getAppPath()),
  });

  const layout = dataDirLayout(info.root);
  for (const dir of [layout.root, layout.media, layout.cache, layout.logs, layout.session]) {
    mkdirSync(dir, { recursive: true });
  }

  app.setPath('userData', layout.root);
  app.setPath('sessionData', layout.session);
  app.setPath('logs', layout.logs);

  resolved = { ...layout, mode: info.mode };
  return resolved;
}

export function getPaths(): ResolvedPaths {
  if (!resolved) throw new Error('initPaths() has not been called');
  return resolved;
}

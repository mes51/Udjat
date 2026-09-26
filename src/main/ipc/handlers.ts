import { app } from 'electron';
import type { Database } from '@main/db/client';
import { sqliteVersion } from '@main/db/client';
import type { ResolvedPaths } from '@main/paths';
import { SettingsRepository } from '@main/settings/repository';
import { handleIpc } from './register';

export interface AppContext {
  db: Database;
  paths: ResolvedPaths;
}

export function registerIpcHandlers(ctx: AppContext): void {
  const settings = new SettingsRepository(ctx.db);

  handleIpc('app:info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    dataDir: ctx.paths.root,
    dataDirMode: ctx.paths.mode,
    versions: {
      electron: process.versions.electron ?? '',
      node: process.versions.node,
      chrome: process.versions.chrome ?? '',
      sqlite: sqliteVersion(ctx.db),
    },
  }));

  handleIpc('settings:get', ({ key }) => settings.get(key) ?? null);
  handleIpc('settings:set', ({ key, value }) => {
    settings.set(key, value);
    return undefined;
  });
  handleIpc('settings:all', () => settings.all());
}

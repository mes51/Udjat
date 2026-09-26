import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { detectDataDir, dataDirLayout } from './data-dir';

const base = {
  exeDir: 'C:\\apps\\Udjat',
  defaultUserData: 'C:\\Users\\me\\AppData\\Roaming\\Udjat',
  devRoot: 'C:\\repo\\Udjat',
};

describe('detectDataDir', () => {
  it('uses .dev-data under the repo when not packaged', () => {
    const info = detectDataDir({ ...base, isPackaged: false, exists: () => false });
    expect(info).toEqual({ mode: 'dev', root: join(base.devRoot, '.dev-data') });
  });

  it('uses standard userData when packaged without marker or data dir', () => {
    const info = detectDataDir({ ...base, isPackaged: true, exists: () => false });
    expect(info).toEqual({ mode: 'standard', root: base.defaultUserData });
  });

  it('uses exe-adjacent data/ when portable.marker exists', () => {
    const marker = join(base.exeDir, 'portable.marker');
    const info = detectDataDir({ ...base, isPackaged: true, exists: (p) => p === marker });
    expect(info).toEqual({ mode: 'portable', root: join(base.exeDir, 'data') });
  });

  it('uses exe-adjacent data/ when data/ already exists (marker deleted later)', () => {
    const data = join(base.exeDir, 'data');
    const info = detectDataDir({ ...base, isPackaged: true, exists: (p) => p === data });
    expect(info).toEqual({ mode: 'portable', root: data });
  });

  it('prefers PORTABLE_EXECUTABLE_DIR over exeDir for the portable target', () => {
    const portableDir = 'E:\\usb\\Udjat';
    const marker = join(portableDir, 'portable.marker');
    const info = detectDataDir({
      ...base,
      isPackaged: true,
      portableExecutableDir: portableDir,
      exists: (p) => p === marker,
    });
    expect(info).toEqual({ mode: 'portable', root: join(portableDir, 'data') });
  });
});

describe('dataDirLayout', () => {
  it('places all subdirectories under root', () => {
    const layout = dataDirLayout('X:\\d');
    expect(layout.database).toBe(join('X:\\d', 'udjat.sqlite'));
    for (const key of ['media', 'cache', 'logs', 'session'] as const) {
      expect(layout[key].startsWith('X:\\d')).toBe(true);
    }
  });
});

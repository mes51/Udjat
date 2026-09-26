import { describe, expect, it } from 'vitest';
import { openDatabase } from '@main/db/client';
import { SettingsRepository } from './repository';

describe('SettingsRepository', () => {
  it('round-trips JSON values and overwrites on conflict', () => {
    const db = openDatabase({ path: ':memory:' });
    const repo = new SettingsRepository(db);

    expect(repo.get('missing')).toBeNull();

    repo.set('theme', 'dark');
    repo.set('window', { width: 1200, height: 800 });
    expect(repo.get('theme')).toBe('dark');
    expect(repo.get('window')).toEqual({ width: 1200, height: 800 });

    repo.set('theme', 'light');
    expect(repo.get('theme')).toBe('light');

    expect(repo.all()).toEqual({ theme: 'light', window: { width: 1200, height: 800 } });
    db.close();
  });
});

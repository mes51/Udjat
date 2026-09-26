import type { Database } from '@main/db/client';

/** settings テーブルへの key-value アクセス。値は JSON で保存する。 */
export class SettingsRepository {
  constructor(private readonly db: Database) {}

  get(key: string): unknown {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as
      { value: string } | undefined;
    return row ? (JSON.parse(row.value) as unknown) : null;
  }

  set(key: string, value: unknown): void {
    this.db
      .prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      )
      .run(key, JSON.stringify(value));
  }

  all(): Record<string, unknown> {
    const rows = this.db.prepare('SELECT key, value FROM settings ORDER BY key').all() as {
      key: string;
      value: string;
    }[];
    const out: Record<string, unknown> = {};
    for (const r of rows) out[r.key] = JSON.parse(r.value) as unknown;
    return out;
  }
}

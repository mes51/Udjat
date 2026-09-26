import { DatabaseSync } from 'node:sqlite';
import { migrations, type Migration } from './migrations';

export type Database = DatabaseSync;

export interface OpenOptions {
  /** ':memory:' を渡すとインメモリ(テスト用) */
  path: string;
}

/**
 * DB を開き、PRAGMA を設定し、未適用のマイグレーションを適用する。
 * node:sqlite(Electron 44 / Node 24 同梱)を使うためネイティブビルド不要。
 */
export function openDatabase(opts: OpenOptions): Database {
  const db = new DatabaseSync(opts.path);
  if (opts.path !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL');
  }
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  runMigrations(db, migrations);
  return db;
}

export function runMigrations(db: Database, list: readonly Migration[]): number[] {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    )
  `);

  const applied = new Set(
    (db.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );

  const sorted = [...list].sort((a, b) => a.version - b.version);
  const newlyApplied: number[] = [];
  const insert = db.prepare(
    'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)',
  );

  for (const m of sorted) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN');
    try {
      db.exec(m.up);
      insert.run(m.version, m.name, Date.now());
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`migration ${m.version} (${m.name}) failed: ${(e as Error).message}`);
    }
    newlyApplied.push(m.version);
  }
  return newlyApplied;
}

export function sqliteVersion(db: Database): string {
  const row = db.prepare('SELECT sqlite_version() AS v').get() as { v: string };
  return row.v;
}

import { describe, expect, it } from 'vitest';
import { openDatabase, runMigrations, sqliteVersion } from './client';
import { migrations } from './migrations';

describe('openDatabase / runMigrations', () => {
  it('applies all migrations on a fresh database', () => {
    const db = openDatabase({ path: ':memory:' });
    const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as {
      version: number;
    }[];
    expect(rows.map((r) => r.version)).toEqual(migrations.map((m) => m.version));
    db.close();
  });

  it('is idempotent', () => {
    const db = openDatabase({ path: ':memory:' });
    expect(runMigrations(db, migrations)).toEqual([]);
    db.close();
  });

  it('creates the expected tables', () => {
    const db = openDatabase({ path: ':memory:' });
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table') ORDER BY name").all() as {
        name: string;
      }[]
    ).map((r) => r.name);
    for (const t of [
      'settings',
      'server_profiles',
      'conversations',
      'messages',
      'attachments',
      'message_attachments',
      'mcp_servers',
      'tool_policies',
      'messages_fts',
      'messages_fts_map',
    ]) {
      expect(names).toContain(t);
    }
    db.close();
  });

  it('supports trigram FTS on Japanese text', () => {
    const db = openDatabase({ path: ':memory:' });
    db.prepare('INSERT INTO messages_fts (rowid, text) VALUES (?, ?)').run(
      1,
      '動画のフレームを抽出する',
    );
    const hits = db
      .prepare('SELECT rowid FROM messages_fts WHERE messages_fts MATCH ?')
      .all('フレーム') as {
      rowid: number;
    }[];
    expect(hits.map((h) => h.rowid)).toEqual([1]);
    db.close();
  });

  it('rolls back a failing migration and reports it', () => {
    const db = openDatabase({ path: ':memory:' });
    expect(() =>
      runMigrations(db, [
        { version: 999, name: 'broken', up: 'CREATE TABLE ok(id); CREATE TABLE ok(id);' },
      ]),
    ).toThrow(/migration 999 \(broken\) failed/);
    const names = (
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'ok'").all() as { name: string }[]
    ).map((r) => r.name);
    expect(names).toEqual([]);
    db.close();
  });

  it('reports the sqlite version', () => {
    const db = openDatabase({ path: ':memory:' });
    expect(sqliteVersion(db)).toMatch(/^3\.\d+/);
    db.close();
  });
});

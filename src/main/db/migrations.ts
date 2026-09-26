/**
 * スキーママイグレーション。追加のみ(既存の version は変更しない)。
 * 設計は docs/plan/05-data-model.md を参照。
 */
export interface Migration {
  version: number;
  name: string;
  up: string;
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'initial',
    up: `
      CREATE TABLE settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE server_profiles (
        id                   TEXT PRIMARY KEY,
        name                 TEXT NOT NULL,
        kind                 TEXT NOT NULL,
        base_url             TEXT NOT NULL,
        api_key              TEXT,
        default_model        TEXT,
        default_params       TEXT NOT NULL DEFAULT '{}',
        capability_overrides TEXT NOT NULL DEFAULT '{}',
        created_at           INTEGER NOT NULL,
        updated_at           INTEGER NOT NULL
      );

      CREATE TABLE conversations (
        id                TEXT PRIMARY KEY,
        title             TEXT NOT NULL DEFAULT '',
        pinned            INTEGER NOT NULL DEFAULT 0,
        server_profile_id TEXT REFERENCES server_profiles(id) ON DELETE SET NULL,
        model             TEXT,
        system_prompt     TEXT,
        params            TEXT NOT NULL DEFAULT '{}',
        enabled_tools     TEXT,
        active_leaf_id    TEXT,
        created_at        INTEGER NOT NULL,
        updated_at        INTEGER NOT NULL
      );
      CREATE INDEX conversations_updated ON conversations(pinned DESC, updated_at DESC);

      CREATE TABLE messages (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        parent_id       TEXT REFERENCES messages(id) ON DELETE CASCADE,
        role            TEXT NOT NULL,
        kind            TEXT NOT NULL DEFAULT 'normal',
        parts           TEXT NOT NULL DEFAULT '[]',
        tool_calls      TEXT,
        tool_call_id    TEXT,
        tool_meta       TEXT,
        model           TEXT,
        usage           TEXT,
        finish_reason   TEXT,
        error           TEXT,
        created_at      INTEGER NOT NULL
      );
      CREATE INDEX messages_conv_parent ON messages(conversation_id, parent_id);

      CREATE TABLE attachments (
        id            TEXT PRIMARY KEY,
        sha256        TEXT NOT NULL UNIQUE,
        mime          TEXT NOT NULL,
        ext           TEXT NOT NULL,
        original_name TEXT NOT NULL,
        size          INTEGER NOT NULL,
        meta          TEXT NOT NULL DEFAULT '{}',
        ref_count     INTEGER NOT NULL DEFAULT 0,
        created_at    INTEGER NOT NULL
      );

      CREATE TABLE message_attachments (
        message_id    TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
        PRIMARY KEY (message_id, attachment_id)
      );

      CREATE TABLE mcp_servers (
        id        TEXT PRIMARY KEY,
        name      TEXT NOT NULL,
        transport TEXT NOT NULL,
        config    TEXT NOT NULL DEFAULT '{}',
        enabled   INTEGER NOT NULL DEFAULT 1,
        autostart INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE tool_policies (
        tool_name TEXT PRIMARY KEY,
        policy    TEXT NOT NULL
      );

      -- 全文検索。text を FTS 側にも持つ通常の FTS5 テーブル(削除・更新が単純になる)。
      -- message_id / conversation_id は検索対象外の付随列。
      CREATE VIRTUAL TABLE messages_fts USING fts5(
        message_id UNINDEXED,
        conversation_id UNINDEXED,
        text,
        tokenize='trigram'
      );
    `,
  },
];

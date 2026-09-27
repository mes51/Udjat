import type { Conversation, ConversationPatch } from '@shared/schemas';
import { newId } from '@main/util/id';
import type { Database } from '../client';

interface Row {
  id: string;
  title: string;
  pinned: number;
  server_profile_id: string | null;
  model: string | null;
  system_prompt: string | null;
  params: string;
  disabled_categories: string;
  disabled_tools: string;
  active_leaf_id: string | null;
  created_at: number;
  updated_at: number;
}

function parseList(json: string): string[] {
  try {
    const v = JSON.parse(json) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function fromRow(r: Row): Conversation {
  return {
    id: r.id,
    title: r.title,
    pinned: r.pinned === 1,
    serverProfileId: r.server_profile_id,
    model: r.model,
    systemPrompt: r.system_prompt,
    params: JSON.parse(r.params) as Conversation['params'],
    disabledCategories: parseList(r.disabled_categories),
    disabledTools: parseList(r.disabled_tools),
    activeLeafId: r.active_leaf_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export interface ConversationCreate {
  serverProfileId: string | null;
  model: string | null;
  systemPrompt?: string | null;
  params?: Conversation['params'];
  title?: string;
  /** 新規会話で最初から無効にしておくカテゴリ(直前の会話の状態を引き継ぐ用) */
  disabledCategories?: string[];
}

export class ConversationRepository {
  constructor(private readonly db: Database) {}

  list(): Conversation[] {
    return (
      this.db
        .prepare('SELECT * FROM conversations ORDER BY pinned DESC, updated_at DESC')
        .all() as unknown as Row[]
    ).map(fromRow);
  }

  get(id: string): Conversation | null {
    const row = this.db.prepare('SELECT * FROM conversations WHERE id = ?').get(id) as unknown as
      Row | undefined;
    return row ? fromRow(row) : null;
  }

  create(input: ConversationCreate): Conversation {
    const now = Date.now();
    const id = newId(now);
    this.db
      .prepare(
        `INSERT INTO conversations
           (id, title, pinned, server_profile_id, model, system_prompt, params, disabled_categories, disabled_tools, active_leaf_id, created_at, updated_at)
         VALUES (?, ?, 0, ?, ?, ?, ?, ?, '[]', NULL, ?, ?)`,
      )
      .run(
        id,
        input.title ?? '',
        input.serverProfileId,
        input.model,
        input.systemPrompt ?? null,
        JSON.stringify(input.params ?? {}),
        JSON.stringify(input.disabledCategories ?? []),
        now,
        now,
      );
    return this.get(id)!;
  }

  update(
    id: string,
    patch: ConversationPatch,
    opts: { touch?: boolean } = {},
  ): Conversation | null {
    const cur = this.get(id);
    if (!cur) return null;
    const next: Conversation = { ...cur, ...stripUndefined(patch) } as Conversation;
    this.db
      .prepare(
        `UPDATE conversations SET title = ?, pinned = ?, server_profile_id = ?, model = ?, system_prompt = ?,
           params = ?, disabled_categories = ?, disabled_tools = ?, active_leaf_id = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.title,
        next.pinned ? 1 : 0,
        next.serverProfileId,
        next.model,
        next.systemPrompt,
        JSON.stringify(next.params),
        JSON.stringify(next.disabledCategories),
        JSON.stringify(next.disabledTools),
        next.activeLeafId,
        opts.touch === false ? cur.updatedAt : Date.now(),
        id,
      );
    return this.get(id);
  }

  delete(id: string): boolean {
    const r = this.db.prepare('DELETE FROM conversations WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM messages_fts WHERE conversation_id = ?').run(id);
    return r.changes > 0;
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o))
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

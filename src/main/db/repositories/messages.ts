import type {
  ToolMeta,
  FinishReason,
  Message,
  MessageKind,
  Part,
  Role,
  ToolCall,
  Usage,
} from '@shared/schemas';
import { newId } from '@main/util/id';
import type { Database } from '../client';

interface Row {
  id: string;
  conversation_id: string;
  parent_id: string | null;
  role: Role;
  kind: MessageKind;
  parts: string;
  tool_calls: string | null;
  tool_call_id: string | null;
  tool_meta: string | null;
  model: string | null;
  usage: string | null;
  finish_reason: FinishReason | null;
  error: string | null;
  created_at: number;
}

function fromRow(r: Row): Message {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    parentId: r.parent_id,
    role: r.role,
    kind: r.kind,
    parts: JSON.parse(r.parts) as Part[],
    toolCalls: r.tool_calls ? (JSON.parse(r.tool_calls) as ToolCall[]) : null,
    toolCallId: r.tool_call_id,
    toolMeta: r.tool_meta ? (JSON.parse(r.tool_meta) as unknown) : null,
    model: r.model,
    usage: r.usage ? (JSON.parse(r.usage) as Usage) : null,
    finishReason: r.finish_reason,
    error: r.error,
    createdAt: r.created_at,
  };
}

export interface MessageCreate {
  conversationId: string;
  parentId: string | null;
  role: Role;
  parts: Part[];
  kind?: MessageKind;
  toolCalls?: ToolCall[] | null;
  toolCallId?: string | null;
  toolMeta?: unknown;
  model?: string | null;
  usage?: Usage | null;
  finishReason?: FinishReason | null;
  error?: string | null;
}

export type MessagePatch = Partial<
  Pick<Message, 'parts' | 'toolCalls' | 'toolMeta' | 'usage' | 'finishReason' | 'error' | 'model'>
>;

export interface BranchInfo {
  index: number;
  count: number;
  ids: string[];
}

export interface SearchHit {
  messageId: string;
  conversationId: string;
  conversationTitle: string;
  role: Role;
  createdAt: number;
  snippet: string;
}

export function partsToText(parts: Part[]): string {
  return parts
    .filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n');
}

/**
 * メッセージはツリー(parent_id)。分岐モデルは docs/plan/05-data-model.md を参照。
 */
export class MessageRepository {
  constructor(private readonly db: Database) {}

  get(id: string): Message | null {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as unknown as
      Row | undefined;
    return row ? fromRow(row) : null;
  }

  create(input: MessageCreate): Message {
    const now = Date.now();
    const id = newId(now);
    this.db
      .prepare(
        `INSERT INTO messages
           (id, conversation_id, parent_id, role, kind, parts, tool_calls, tool_call_id, tool_meta, model, usage, finish_reason, error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.conversationId,
        input.parentId,
        input.role,
        input.kind ?? 'normal',
        JSON.stringify(input.parts),
        input.toolCalls ? JSON.stringify(input.toolCalls) : null,
        input.toolCallId ?? null,
        input.toolMeta !== undefined && input.toolMeta !== null
          ? JSON.stringify(input.toolMeta)
          : null,
        input.model ?? null,
        input.usage ? JSON.stringify(input.usage) : null,
        input.finishReason ?? null,
        input.error ?? null,
        now,
      );
    this.syncFts(id, input.conversationId, input.parts);
    return this.get(id)!;
  }

  update(id: string, patch: MessagePatch): Message | null {
    const cur = this.get(id);
    if (!cur) return null;
    const next = { ...cur, ...stripUndefined(patch) };
    this.db
      .prepare(
        `UPDATE messages SET parts = ?, tool_calls = ?, tool_meta = ?, model = ?, usage = ?, finish_reason = ?, error = ?
         WHERE id = ?`,
      )
      .run(
        JSON.stringify(next.parts),
        next.toolCalls ? JSON.stringify(next.toolCalls) : null,
        next.toolMeta !== null && next.toolMeta !== undefined
          ? JSON.stringify(next.toolMeta)
          : null,
        next.model,
        next.usage ? JSON.stringify(next.usage) : null,
        next.finishReason,
        next.error,
        id,
      );
    if (patch.parts) this.syncFts(id, cur.conversationId, patch.parts);
    return this.get(id);
  }

  /** 葉から root までを辿り、root -> 葉 の順で返す */
  pathToRoot(leafId: string): Message[] {
    const rows = this.db
      .prepare(
        `WITH RECURSIVE chain(id, depth) AS (
           SELECT id, 0 FROM messages WHERE id = ?
           UNION ALL
           SELECT m.parent_id, c.depth + 1 FROM messages m JOIN chain c ON m.id = c.id WHERE m.parent_id IS NOT NULL
         )
         SELECT m.* FROM messages m JOIN chain c ON m.id = c.id ORDER BY c.depth DESC`,
      )
      .all(leafId) as unknown as Row[];
    return rows.map(fromRow);
  }

  children(conversationId: string, parentId: string | null): Message[] {
    const rows = (parentId === null
      ? this.db
          .prepare(
            'SELECT * FROM messages WHERE conversation_id = ? AND parent_id IS NULL ORDER BY created_at',
          )
          .all(conversationId)
      : this.db
          .prepare(
            'SELECT * FROM messages WHERE conversation_id = ? AND parent_id = ? ORDER BY created_at',
          )
          .all(conversationId, parentId)) as unknown as Row[];
    return rows.map(fromRow);
  }

  /** 兄弟(同じ親を持つメッセージ)を作成順で返す */
  siblings(message: Message): Message[] {
    return this.children(message.conversationId, message.parentId);
  }

  /** 指定ノード配下で最後に作成された葉(分岐切替時の active_leaf 決定用) */
  latestLeafUnder(id: string): Message {
    let cur = this.get(id);
    if (!cur) throw new Error(`message not found: ${id}`);
    for (;;) {
      const kids = this.children(cur.conversationId, cur.id);
      if (kids.length === 0) return cur;
      cur = kids[kids.length - 1]!;
    }
  }

  /**
   * パス上の各メッセージについて、兄弟(同じ親を持つ分岐)の位置と一覧を返す。
   * 兄弟が 1 つしかないものは含めない。
   */
  branches(path: Message[]): Record<string, BranchInfo> {
    const out: Record<string, BranchInfo> = {};
    for (const m of path) {
      const sibs = this.children(m.conversationId, m.parentId);
      if (sibs.length <= 1) continue;
      out[m.id] = {
        index: sibs.findIndex((s) => s.id === m.id),
        count: sibs.length,
        ids: sibs.map((s) => s.id),
      };
    }
    return out;
  }

  listByConversation(conversationId: string): Message[] {
    return (
      this.db
        .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at')
        .all(conversationId) as unknown as Row[]
    ).map(fromRow);
  }

  /** バックグラウンド実行中のまま残っている tool メッセージ(起動時の後始末用。M16) */
  listBackgroundRunning(): Message[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM messages WHERE role = 'tool' AND tool_meta LIKE '%"status":"running"%'`,
        )
        .all() as unknown as Row[]
    )
      .map(fromRow)
      .filter((m) => (m.toolMeta as ToolMeta | null)?.background?.status === 'running');
  }

  delete(id: string): boolean {
    const r = this.db.prepare('DELETE FROM messages WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM messages_fts WHERE message_id = ?').run(id);
    return r.changes > 0;
  }

  /**
   * 全文検索。trigram トークナイザは 3 文字未満のクエリにマッチしないため、
   * 短いクエリは LIKE にフォールバックする。
   */
  search(query: string, limit = 50): SearchHit[] {
    const q = query.trim();
    if (q.length === 0) return [];
    // 短いクエリは LIKE、それ以外は FTS(MATCH のメタ文字を無効化するため文字列リテラルにする)
    const useLike = [...q].length < 3;
    const where = useLike ? `f.text LIKE ? ESCAPE '\\'` : `messages_fts MATCH ?`;
    const arg = useLike
      ? `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
      : `"${q.replace(/"/g, '""')}"`;
    const snippet = useLike
      ? `substr(f.text, 1, 80)`
      : `snippet(messages_fts, 2, '[', ']', '…', 12)`;
    const order = useLike ? `m.created_at DESC` : `rank`;
    const rows = this.db
      .prepare(
        `SELECT f.message_id, f.conversation_id, c.title AS conversation_title, m.role, m.created_at,
                ${snippet} AS snippet
         FROM messages_fts f
         JOIN messages m ON m.id = f.message_id
         JOIN conversations c ON c.id = f.conversation_id
         WHERE ${where} AND m.kind = 'normal' AND m.role IN ('user', 'assistant')
         ORDER BY ${order} LIMIT ?`,
      )
      .all(arg, limit) as {
      message_id: string;
      conversation_id: string;
      conversation_title: string;
      role: Role;
      created_at: number;
      snippet: string;
    }[];
    return rows.map((r) => ({
      messageId: r.message_id,
      conversationId: r.conversation_id,
      conversationTitle: r.conversation_title,
      role: r.role,
      createdAt: r.created_at,
      snippet: r.snippet,
    }));
  }

  private syncFts(id: string, conversationId: string, parts: Part[]): void {
    this.db.prepare('DELETE FROM messages_fts WHERE message_id = ?').run(id);
    const text = partsToText(parts);
    if (text.trim().length > 0) {
      this.db
        .prepare('INSERT INTO messages_fts (message_id, conversation_id, text) VALUES (?, ?, ?)')
        .run(id, conversationId, text);
    }
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o))
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

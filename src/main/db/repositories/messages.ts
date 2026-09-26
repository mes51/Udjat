import type {
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

  listByConversation(conversationId: string): Message[] {
    return (
      this.db
        .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at')
        .all(conversationId) as unknown as Row[]
    ).map(fromRow);
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
  search(
    query: string,
    limit = 50,
  ): { messageId: string; conversationId: string; snippet: string }[] {
    const q = query.trim();
    if (q.length === 0) return [];
    if ([...q].length < 3) {
      const rows = this.db
        .prepare(
          `SELECT message_id, conversation_id, substr(text, 1, 80) AS snippet
           FROM messages_fts WHERE text LIKE ? ESCAPE '\\' LIMIT ?`,
        )
        .all(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, limit) as {
        message_id: string;
        conversation_id: string;
        snippet: string;
      }[];
      return rows.map((r) => ({
        messageId: r.message_id,
        conversationId: r.conversation_id,
        snippet: r.snippet,
      }));
    }
    // MATCH 構文のメタ文字を無効化するため、クエリ全体を文字列リテラルとして渡す
    const literal = `"${q.replace(/"/g, '""')}"`;
    const rows = this.db
      .prepare(
        `SELECT message_id, conversation_id, snippet(messages_fts, 2, '[', ']', '…', 12) AS snippet
         FROM messages_fts WHERE messages_fts MATCH ? ORDER BY rank LIMIT ?`,
      )
      .all(literal, limit) as { message_id: string; conversation_id: string; snippet: string }[];
    return rows.map((r) => ({
      messageId: r.message_id,
      conversationId: r.conversation_id,
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

import type { Attachment, AttachmentMeta } from '@shared/schemas';
import { newId } from '@main/util/id';
import type { Database } from '../client';

interface Row {
  id: string;
  sha256: string;
  mime: string;
  ext: string;
  original_name: string;
  size: number;
  meta: string;
  ref_count: number;
  created_at: number;
}

function fromRow(r: Row): Attachment {
  return {
    id: r.id,
    sha256: r.sha256,
    mime: r.mime,
    ext: r.ext,
    originalName: r.original_name,
    size: r.size,
    meta: JSON.parse(r.meta) as AttachmentMeta,
    refCount: r.ref_count,
    createdAt: r.created_at,
  };
}

export class AttachmentRepository {
  constructor(private readonly db: Database) {}

  get(id: string): Attachment | null {
    const row = this.db.prepare('SELECT * FROM attachments WHERE id = ?').get(id) as unknown as
      Row | undefined;
    return row ? fromRow(row) : null;
  }

  getBySha(sha256: string): Attachment | null {
    const row = this.db
      .prepare('SELECT * FROM attachments WHERE sha256 = ?')
      .get(sha256) as unknown as Row | undefined;
    return row ? fromRow(row) : null;
  }

  create(input: {
    sha256: string;
    mime: string;
    ext: string;
    originalName: string;
    size: number;
    meta: AttachmentMeta;
  }): Attachment {
    const now = Date.now();
    const id = newId(now);
    this.db
      .prepare(
        `INSERT INTO attachments (id, sha256, mime, ext, original_name, size, meta, ref_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(
        id,
        input.sha256,
        input.mime,
        input.ext,
        input.originalName,
        input.size,
        JSON.stringify(input.meta),
        now,
      );
    return this.get(id)!;
  }

  updateMeta(id: string, meta: AttachmentMeta): void {
    this.db.prepare('UPDATE attachments SET meta = ? WHERE id = ?').run(JSON.stringify(meta), id);
  }

  /** 作り直した派生物のサイズを反映する(M23。sha256 は元のまま) */
  updateSize(id: string, size: number): void {
    this.db.prepare('UPDATE attachments SET size = ? WHERE id = ?').run(size, id);
  }

  /** 派生物(derivedFrom を持つ添付)。conversationId を指定すればその会話のメッセージに付いているものだけ */
  listDerived(conversationId?: string): Attachment[] {
    const rows = (conversationId
      ? this.db
          .prepare(
            `SELECT DISTINCT a.* FROM attachments a
               JOIN message_attachments ma ON ma.attachment_id = a.id
               JOIN messages m ON m.id = ma.message_id
               WHERE m.conversation_id = ? AND a.meta LIKE '%"derivedFrom"%'
               ORDER BY a.created_at`,
          )
          .all(conversationId)
      : this.db
          .prepare(
            `SELECT * FROM attachments WHERE meta LIKE '%"derivedFrom"%' ORDER BY created_at`,
          )
          .all()) as unknown as Row[];
    return rows.map(fromRow).filter((a) => a.meta.derivedFrom !== undefined);
  }

  /** メッセージとの関連付け(参照カウントを増やす) */
  link(messageId: string, attachmentId: string): void {
    const r = this.db
      .prepare(
        'INSERT OR IGNORE INTO message_attachments (message_id, attachment_id) VALUES (?, ?)',
      )
      .run(messageId, attachmentId);
    if (r.changes > 0) {
      this.db
        .prepare('UPDATE attachments SET ref_count = ref_count + 1 WHERE id = ?')
        .run(attachmentId);
    }
  }

  listAll(): Attachment[] {
    return (this.db.prepare('SELECT * FROM attachments').all() as unknown as Row[]).map(fromRow);
  }

  /** 会話のどこかのメッセージに付いている添付(全分岐、作成順) */
  listForConversation(conversationId: string): Attachment[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT a.* FROM attachments a
           JOIN message_attachments ma ON ma.attachment_id = a.id
           JOIN messages m ON m.id = ma.message_id
           WHERE m.conversation_id = ?
           ORDER BY a.created_at`,
        )
        .all(conversationId) as unknown as Row[]
    ).map(fromRow);
  }

  /** どのメッセージからも参照されていない添付(削除候補) */
  listUnreferenced(): Attachment[] {
    return (
      this.db
        .prepare(
          `SELECT a.* FROM attachments a
           WHERE NOT EXISTS (SELECT 1 FROM message_attachments m WHERE m.attachment_id = a.id)`,
        )
        .all() as unknown as Row[]
    ).map(fromRow);
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM attachments WHERE id = ?').run(id).changes > 0;
  }
}

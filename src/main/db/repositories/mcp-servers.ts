import { McpServerSchema, type McpServer, type McpServerInput } from '@shared/schemas';
import { newId } from '@main/util/id';
import type { Database } from '../client';

interface Row {
  id: string;
  name: string;
  transport: 'stdio' | 'http';
  config: string;
  enabled: number;
  autostart: number;
}

function fromRow(r: Row): McpServer {
  return McpServerSchema.parse({
    id: r.id,
    name: r.name,
    transport: r.transport,
    config: JSON.parse(r.config) as unknown,
    enabled: r.enabled === 1,
    autostart: r.autostart === 1,
  });
}

export class McpServerRepository {
  constructor(private readonly db: Database) {}

  list(): McpServer[] {
    return (
      this.db.prepare('SELECT * FROM mcp_servers ORDER BY name').all() as unknown as Row[]
    ).map(fromRow);
  }

  get(id: string): McpServer | null {
    const row = this.db.prepare('SELECT * FROM mcp_servers WHERE id = ?').get(id) as unknown as
      Row | undefined;
    return row ? fromRow(row) : null;
  }

  create(input: McpServerInput): McpServer {
    const parsed = McpServerSchema.parse({ ...input, id: newId() });
    this.db
      .prepare(
        'INSERT INTO mcp_servers (id, name, transport, config, enabled, autostart) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        parsed.id,
        parsed.name,
        parsed.transport,
        JSON.stringify(parsed.config),
        parsed.enabled ? 1 : 0,
        parsed.autostart ? 1 : 0,
      );
    return this.get(parsed.id)!;
  }

  update(
    id: string,
    input: { [K in keyof McpServerInput]?: McpServerInput[K] | undefined },
  ): McpServer | null {
    const cur = this.get(id);
    if (!cur) return null;
    const merged: Record<string, unknown> = { ...cur };
    for (const [k, v] of Object.entries(input)) if (v !== undefined) merged[k] = v;
    const parsed = McpServerSchema.parse(merged);
    this.db
      .prepare(
        'UPDATE mcp_servers SET name = ?, transport = ?, config = ?, enabled = ?, autostart = ? WHERE id = ?',
      )
      .run(
        parsed.name,
        parsed.transport,
        JSON.stringify(parsed.config),
        parsed.enabled ? 1 : 0,
        parsed.autostart ? 1 : 0,
        id,
      );
    return this.get(id);
  }

  delete(id: string): boolean {
    return this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id).changes > 0;
  }
}

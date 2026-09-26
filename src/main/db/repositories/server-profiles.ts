import type { ServerProfile, ServerProfileInput } from '@shared/schemas';
import { newId } from '@main/util/id';
import type { Database } from '../client';

interface Row {
  id: string;
  name: string;
  kind: ServerProfile['kind'];
  base_url: string;
  api_key: string | null;
  default_model: string | null;
  default_params: string;
  capability_overrides: string;
  created_at: number;
  updated_at: number;
}

function fromRow(r: Row): ServerProfile {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind,
    baseUrl: r.base_url,
    apiKey: r.api_key,
    defaultModel: r.default_model,
    defaultParams: JSON.parse(r.default_params) as ServerProfile['defaultParams'],
    capabilityOverrides: JSON.parse(r.capability_overrides) as ServerProfile['capabilityOverrides'],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export type ServerProfilePatch = {
  [K in keyof ServerProfileInput]?: ServerProfileInput[K] | undefined;
};

export class ServerProfileRepository {
  constructor(private readonly db: Database) {}

  list(): ServerProfile[] {
    return (
      this.db.prepare('SELECT * FROM server_profiles ORDER BY created_at').all() as unknown as Row[]
    ).map(fromRow);
  }

  get(id: string): ServerProfile | null {
    const row = this.db.prepare('SELECT * FROM server_profiles WHERE id = ?').get(id) as unknown as
      Row | undefined;
    return row ? fromRow(row) : null;
  }

  create(input: ServerProfileInput): ServerProfile {
    const now = Date.now();
    const id = newId(now);
    this.db
      .prepare(
        `INSERT INTO server_profiles
           (id, name, kind, base_url, api_key, default_model, default_params, capability_overrides, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.kind,
        input.baseUrl,
        input.apiKey,
        input.defaultModel,
        JSON.stringify(input.defaultParams),
        JSON.stringify(input.capabilityOverrides),
        now,
        now,
      );
    return this.get(id)!;
  }

  update(id: string, input: ServerProfilePatch): ServerProfile | null {
    const cur = this.get(id);
    if (!cur) return null;
    const next: ServerProfile = { ...cur };
    for (const [k, v] of Object.entries(input)) {
      if (v !== undefined) (next as unknown as Record<string, unknown>)[k] = v;
    }
    this.db
      .prepare(
        `UPDATE server_profiles SET name = ?, kind = ?, base_url = ?, api_key = ?, default_model = ?,
           default_params = ?, capability_overrides = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.name,
        next.kind,
        next.baseUrl,
        next.apiKey,
        next.defaultModel,
        JSON.stringify(next.defaultParams),
        JSON.stringify(next.capabilityOverrides),
        Date.now(),
        id,
      );
    return this.get(id);
  }

  delete(id: string): boolean {
    const r = this.db.prepare('DELETE FROM server_profiles WHERE id = ?').run(id);
    return r.changes > 0;
  }
}

import type { ServerProfile, ServerProfileInput } from '@shared/schemas';
import { DEFAULT_MODEL_MANAGEMENT } from '@shared/schemas';
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
  model_capability_overrides: string;
  model_management: string;
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
    modelCapabilityOverrides: JSON.parse(
      r.model_capability_overrides,
    ) as ServerProfile['modelCapabilityOverrides'],
    modelManagement: {
      ...DEFAULT_MODEL_MANAGEMENT,
      ...(JSON.parse(r.model_management || '{}') as Partial<ServerProfile['modelManagement']>),
    },
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
           (id, name, kind, base_url, api_key, default_model, default_params, capability_overrides, model_capability_overrides, model_management, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        JSON.stringify(input.modelCapabilityOverrides ?? {}),
        JSON.stringify(input.modelManagement ?? DEFAULT_MODEL_MANAGEMENT),
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
           default_params = ?, capability_overrides = ?, model_capability_overrides = ?, model_management = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.name,
        next.kind,
        next.baseUrl,
        next.apiKey,
        next.defaultModel,
        JSON.stringify(next.defaultParams),
        JSON.stringify(next.capabilityOverrides),
        JSON.stringify(next.modelCapabilityOverrides),
        JSON.stringify(next.modelManagement),
        Date.now(),
        id,
      );
    return this.get(id);
  }

  /** モデル単位の capability 上書きを設定する。overrides が空なら削除 */
  setModelCapabilities(
    id: string,
    model: string,
    overrides: ServerProfile['capabilityOverrides'],
  ): ServerProfile | null {
    const cur = this.get(id);
    if (!cur) return null;
    const next = { ...cur.modelCapabilityOverrides };
    const cleaned = Object.fromEntries(
      Object.entries(overrides).filter(([, v]) => v !== undefined),
    );
    if (Object.keys(cleaned).length === 0) delete next[model];
    else next[model] = cleaned;
    return this.update(id, { modelCapabilityOverrides: next });
  }

  delete(id: string): boolean {
    const r = this.db.prepare('DELETE FROM server_profiles WHERE id = ?').run(id);
    return r.changes > 0;
  }
}

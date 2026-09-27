import { McpServerInputSchema, ServerProfileInputSchema, ToolPolicySchema } from '@shared/schemas';
import { z } from 'zod';
import type { McpServerRepository } from '@main/db/repositories/mcp-servers';
import type { ServerProfileRepository } from '@main/db/repositories/server-profiles';
import type { ToolRegistry } from '@main/tools/registry';
import type { SettingsRepository } from './repository';

/**
 * 設定一式のエクスポート/インポート。別 PC や再インストール後に引き継ぐためのもの。
 * 会話やメディアは含まない(それらは data/ ごとコピーする)。
 */

const BackupSchema = z.object({
  format: z.literal('udjat-settings'),
  version: z.literal(1),
  exportedAt: z.string().optional(),
  settings: z.record(z.string(), z.unknown()).default({}),
  profiles: z.array(ServerProfileInputSchema).default([]),
  mcpServers: z.array(McpServerInputSchema).default([]),
  toolPolicies: z.record(z.string(), ToolPolicySchema).default({}),
});

export interface BackupDeps {
  settings: SettingsRepository;
  profiles: ServerProfileRepository;
  mcpServers: McpServerRepository;
  tools: ToolRegistry;
}

export function exportSettings(deps: BackupDeps, opts: { includeSecrets: boolean }): string {
  const profiles = deps.profiles.list().map((p) => ({
    name: p.name,
    kind: p.kind,
    baseUrl: p.baseUrl,
    apiKey: opts.includeSecrets ? p.apiKey : null,
    defaultModel: p.defaultModel,
    defaultParams: p.defaultParams,
    capabilityOverrides: p.capabilityOverrides,
    modelCapabilityOverrides: p.modelCapabilityOverrides,
    modelManagement: p.modelManagement,
  }));
  const mcpServers = deps.mcpServers.list().map(({ id: _id, ...rest }) => {
    if (!opts.includeSecrets && rest.transport === 'http') {
      return { ...rest, config: { ...(rest.config as { url: string }), headers: {} } };
    }
    return rest;
  });
  const settings = deps.settings.all();
  if (!opts.includeSecrets) delete settings['webSearch.braveApiKey'];
  const toolPolicies: Record<string, string> = {};
  for (const t of deps.tools.list()) toolPolicies[t.name] = t.policy;
  return JSON.stringify(
    {
      format: 'udjat-settings',
      version: 1,
      exportedAt: new Date().toISOString(),
      settings,
      profiles,
      mcpServers,
      toolPolicies,
    },
    null,
    2,
  );
}

/** 同名のプロファイル / MCP サーバーは上書き、設定キーはマージ */
export function importSettings(
  deps: BackupDeps,
  json: string,
): { settings: number; profiles: number; mcpServers: number; toolPolicies: number } {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new Error(`JSON として読めません: ${(e as Error).message}`);
  }
  const parsed = BackupSchema.safeParse(raw);
  if (!parsed.success)
    throw new Error(`Udjat の設定ファイルではありません: ${parsed.error.message.slice(0, 200)}`);
  const b = parsed.data;

  let settings = 0;
  for (const [k, v] of Object.entries(b.settings)) {
    deps.settings.set(k, v);
    settings++;
  }
  let profiles = 0;
  const existingProfiles = deps.profiles.list();
  for (const p of b.profiles) {
    const same = existingProfiles.find((x) => x.name === p.name);
    // 秘密情報を含まないバックアップで既存のキーを消さない
    const patch = { ...p, ...(p.apiKey === null && same?.apiKey ? { apiKey: same.apiKey } : {}) };
    if (same) deps.profiles.update(same.id, patch);
    else deps.profiles.create(p);
    profiles++;
  }
  let mcpServers = 0;
  const existingMcp = deps.mcpServers.list();
  for (const s of b.mcpServers) {
    const same = existingMcp.find((x) => x.name === s.name);
    if (same) deps.mcpServers.update(same.id, s);
    else deps.mcpServers.create(s);
    mcpServers++;
  }
  let toolPolicies = 0;
  for (const [name, policy] of Object.entries(b.toolPolicies)) {
    deps.tools.setPolicy(name, policy);
    toolPolicies++;
  }
  return { settings, profiles, mcpServers, toolPolicies };
}

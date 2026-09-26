import type { McpServer, McpServerInput } from '@shared/schemas';

/**
 * Claude Desktop 等と同じ `{ "mcpServers": { name: { command, args, env } | { url, headers } } }`
 * 形式の JSON を読み書きする。
 */

export function parseMcpServersJson(json: string): McpServerInput[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch (e) {
    throw new Error(`JSON として読めません: ${(e as Error).message}`);
  }
  const root = (data as { mcpServers?: unknown })?.mcpServers ?? data;
  if (!root || typeof root !== 'object' || Array.isArray(root)) {
    throw new Error('mcpServers オブジェクトが見つかりません');
  }
  const out: McpServerInput[] = [];
  for (const [name, raw] of Object.entries(root as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const c = raw as Record<string, unknown>;
    const disabled = c['disabled'] === true;
    if (typeof c['url'] === 'string') {
      out.push({
        name,
        transport: 'http',
        config: {
          url: c['url'],
          headers: isStringRecord(c['headers']) ? c['headers'] : {},
        },
        enabled: !disabled,
        autostart: !disabled,
      });
    } else if (typeof c['command'] === 'string') {
      out.push({
        name,
        transport: 'stdio',
        config: {
          command: c['command'],
          args: Array.isArray(c['args']) ? c['args'].map(String) : [],
          env: isStringRecord(c['env']) ? c['env'] : {},
          ...(typeof c['cwd'] === 'string' ? { cwd: c['cwd'] } : {}),
        },
        enabled: !disabled,
        autostart: !disabled,
      });
    }
  }
  return out;
}

export function toMcpServersJson(servers: McpServer[]): string {
  const mcpServers: Record<string, unknown> = {};
  for (const s of servers) {
    const entry: Record<string, unknown> =
      s.transport === 'stdio'
        ? {
            command: (s.config as { command: string }).command,
            args: (s.config as { args: string[] }).args,
            ...(Object.keys((s.config as { env: Record<string, string> }).env).length > 0
              ? { env: (s.config as { env: Record<string, string> }).env }
              : {}),
            ...((s.config as { cwd?: string }).cwd
              ? { cwd: (s.config as { cwd?: string }).cwd }
              : {}),
          }
        : {
            url: (s.config as { url: string }).url,
            ...(Object.keys((s.config as { headers: Record<string, string> }).headers).length > 0
              ? { headers: (s.config as { headers: Record<string, string> }).headers }
              : {}),
          };
    if (!s.enabled) entry['disabled'] = true;
    mcpServers[s.name] = entry;
  }
  return JSON.stringify({ mcpServers }, null, 2);
}

function isStringRecord(v: unknown): v is Record<string, string> {
  return (
    !!v &&
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.values(v).every((x) => typeof x === 'string')
  );
}

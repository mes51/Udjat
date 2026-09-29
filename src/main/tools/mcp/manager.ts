import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer, McpServerStatus } from '@shared/schemas';
import type { MediaStore } from '@main/media/store';
import type { ToolRegistry } from '../registry';
import type { RegisteredTool, ToolMedia, ToolResult } from '../types';

/**
 * MCP クライアントの管理。サーバーごとに接続を持ち、tools/list の結果を
 * ToolRegistry に "<server>__<tool>" として登録する。設計は docs/plan/04-tools-and-mcp.md。
 */

export interface McpManagerDeps {
  registry: ToolRegistry;
  /** image content を添付として保存するため(無ければ画像は捨ててテキスト注記にする) */
  media?: MediaStore;
  onStatusChange?: (status: McpServerStatus) => void;
  /** 接続・ツール呼び出しのタイムアウト(ミリ秒) */
  /** ツール呼び出しの制限時間。0 以下なら無制限(画像・動画生成のように長い同期呼び出し向け)。関数なら呼び出しのたびに評価 */
  requestTimeoutMs?: number | (() => number);
}

interface Connection {
  server: McpServer;
  client: Client;
  toolNames: string[];
  status: McpServerStatus;
}

/** ツール名の名前空間に使えるようサーバー名を正規化する */
export function namespaceOf(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return base || 'mcp';
}

export function qualifiedToolName(server: McpServer, toolName: string): string {
  return `${namespaceOf(server.name)}__${toolName}`;
}

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource'; resource: { uri: string; text?: string; blob?: string; mimeType?: string } }
  | { type: 'resource_link'; uri: string; name?: string; description?: string }
  | { type: string };

export class McpManager {
  private readonly connections = new Map<string, Connection>();
  private readonly statuses = new Map<string, McpServerStatus>();

  constructor(private readonly deps: McpManagerDeps) {}

  status(server: McpServer): McpServerStatus {
    return (
      this.statuses.get(server.id) ?? {
        id: server.id,
        state: 'disconnected',
        error: null,
        tools: [],
        serverName: null,
        serverVersion: null,
      }
    );
  }

  allStatuses(): McpServerStatus[] {
    return [...this.statuses.values()];
  }

  isConnected(id: string): boolean {
    return this.connections.has(id);
  }

  private setStatus(status: McpServerStatus): void {
    this.statuses.set(status.id, status);
    this.deps.onStatusChange?.(status);
  }

  async connect(server: McpServer): Promise<McpServerStatus> {
    await this.disconnect(server.id);
    this.setStatus({
      id: server.id,
      state: 'connecting',
      error: null,
      tools: [],
      serverName: null,
      serverVersion: null,
    });
    const client = new Client({ name: 'udjat', version: '0.1.0' }, { capabilities: {} });
    try {
      const transport =
        server.transport === 'stdio'
          ? new StdioClientTransport({
              command: (server.config as { command: string }).command,
              args: (server.config as { args: string[] }).args,
              env: { ...defaultEnv(), ...(server.config as { env: Record<string, string> }).env },
              ...((server.config as { cwd?: string }).cwd
                ? { cwd: (server.config as { cwd?: string }).cwd }
                : {}),
              stderr: 'pipe',
            })
          : new StreamableHTTPClientTransport(new URL((server.config as { url: string }).url), {
              requestInit: {
                headers: (server.config as { headers: Record<string, string> }).headers,
              },
            });
      // SDK の Transport 型は exactOptionalPropertyTypes と相性が悪いので明示的に合わせる
      await client.connect(transport as unknown as Parameters<Client['connect']>[0], {
        timeout: 30_000,
      });
      const conn: Connection = {
        server,
        client,
        toolNames: [],
        status: this.status(server),
      };
      this.connections.set(server.id, conn);

      client.onclose = () => {
        if (this.connections.get(server.id) === conn) {
          this.unregisterTools(conn);
          this.connections.delete(server.id);
          const cur = this.statuses.get(server.id);
          if (cur?.state === 'connected') {
            this.setStatus({ ...cur, state: 'disconnected', tools: [] });
          }
        }
      };
      client.onerror = (e) => {
        const cur = this.statuses.get(server.id);
        if (cur) this.setStatus({ ...cur, error: String((e as Error).message ?? e) });
      };
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        void this.refreshTools(conn);
      });

      await this.refreshTools(conn);
      const version = client.getServerVersion();
      this.setStatus({
        id: server.id,
        state: 'connected',
        error: null,
        tools: this.statuses.get(server.id)?.tools ?? [],
        serverName: version?.name ?? null,
        serverVersion: version?.version ?? null,
      });
      return this.status(server);
    } catch (e) {
      try {
        await client.close();
      } catch {
        /* ignore */
      }
      const message = (e as Error).message ?? String(e);
      this.setStatus({
        id: server.id,
        state: 'error',
        error: message,
        tools: [],
        serverName: null,
        serverVersion: null,
      });
      return this.status(server);
    }
  }

  async disconnect(id: string): Promise<void> {
    const conn = this.connections.get(id);
    if (!conn) return;
    this.connections.delete(id);
    this.unregisterTools(conn);
    try {
      await conn.client.close();
    } catch {
      /* ignore */
    }
    this.setStatus({
      id,
      state: 'disconnected',
      error: null,
      tools: [],
      serverName: null,
      serverVersion: null,
    });
  }

  async disconnectAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)));
  }

  /** 設定に従って自動接続する(起動時) */
  async autostart(servers: McpServer[]): Promise<void> {
    await Promise.all(servers.filter((s) => s.enabled && s.autostart).map((s) => this.connect(s)));
  }

  private unregisterTools(conn: Connection): void {
    for (const n of conn.toolNames) this.deps.registry.unregister(n);
    conn.toolNames = [];
  }

  private async refreshTools(conn: Connection): Promise<void> {
    const { tools } = await conn.client.listTools();
    this.unregisterTools(conn);
    const registered: { name: string; description: string }[] = [];
    for (const t of tools) {
      const name = qualifiedToolName(conn.server, t.name);
      const tool: RegisteredTool = {
        definition: {
          name,
          description: t.description ?? `${conn.server.name} の ${t.name}`,
          parameters: (t.inputSchema as Record<string, unknown>) ?? {
            type: 'object',
            properties: {},
          },
        },
        source: { kind: 'mcp', serverId: conn.server.id },
        category: `mcp:${conn.server.id}`,
        categoryLabel: conn.server.name,
        defaultPolicy: 'ask',
        execute: async (args, ctx) => this.call(conn, t.name, args, ctx.signal),
      };
      // 組み込みや別サーバーと衝突したら登録しない(接続状態には残す)
      if (this.deps.registry.get(name)) continue;
      this.deps.registry.register(tool);
      conn.toolNames.push(name);
      registered.push({ name, description: tool.definition.description });
    }
    const cur = this.statuses.get(conn.server.id);
    this.setStatus({
      id: conn.server.id,
      state: cur?.state === 'connecting' ? 'connecting' : 'connected',
      error: cur?.error ?? null,
      tools: registered,
      serverName: cur?.serverName ?? null,
      serverVersion: cur?.serverVersion ?? null,
    });
  }

  private async call(
    conn: Connection,
    toolName: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const configured =
      typeof this.deps.requestTimeoutMs === 'function'
        ? this.deps.requestTimeoutMs()
        : this.deps.requestTimeoutMs;
    // SDK の既定は 60 秒。0 以下は「無制限」扱いにする(setTimeout の上限まで)。進捗通知が来たら数え直す
    const timeout =
      configured === undefined ? 120_000 : configured > 0 ? configured : 2_147_483_647;
    const result = await conn.client.callTool({ name: toolName, arguments: args }, undefined, {
      signal,
      timeout,
      resetTimeoutOnProgress: true,
    });
    return this.convert(
      conn,
      toolName,
      result as { content?: ContentBlock[]; isError?: boolean; structuredContent?: unknown },
    );
  }

  /** MCP の content[] を ToolResult に変換する。画像は添付として保存して media に載せる */
  private async convert(
    conn: Connection,
    toolName: string,
    result: { content?: ContentBlock[]; isError?: boolean; structuredContent?: unknown },
  ): Promise<ToolResult> {
    const texts: string[] = [];
    const media: ToolMedia[] = [];
    for (const block of result.content ?? []) {
      if (block.type === 'text') texts.push((block as { text: string }).text);
      else if (block.type === 'image' || block.type === 'audio') {
        const b = block as { data: string; mimeType: string };
        if (block.type === 'image' && this.deps.media) {
          const ext = b.mimeType.split('/')[1] ?? 'png';
          const a = await this.deps.media.addBytes(
            Buffer.from(b.data, 'base64'),
            `${conn.server.name}-${toolName}.${ext}`,
            b.mimeType,
          );
          media.push({
            attachmentId: a.id,
            mime: a.mime,
            kind: 'image',
            label: `${toolName} の画像`,
          });
          texts.push(`[image ${media.length}: attached]`);
        } else {
          texts.push(
            `[${block.type} ${b.mimeType}: ${Math.round((b.data.length * 3) / 4 / 1024)} KB, 未対応のため省略]`,
          );
        }
      } else if (block.type === 'resource') {
        const r = (
          block as { resource: { uri: string; text?: string; blob?: string; mimeType?: string } }
        ).resource;
        if (r.text !== undefined) texts.push(`[resource ${r.uri}]\n${r.text}`);
        else
          texts.push(
            `[resource ${r.uri}${r.mimeType ? ` (${r.mimeType})` : ''}: バイナリのため省略]`,
          );
      } else if (block.type === 'resource_link') {
        const r = block as { uri: string; name?: string; description?: string };
        texts.push(
          `[resource link: ${r.name ?? r.uri} ${r.uri}${r.description ? ` - ${r.description}` : ''}]`,
        );
      }
    }
    if (texts.length === 0 && result.structuredContent !== undefined) {
      texts.push(JSON.stringify(result.structuredContent));
    }
    const out: ToolResult = { text: texts.join('\n') || '(empty result)' };
    if (media.length > 0) out.media = media;
    if (result.isError) {
      out.isError = true;
      out.text = `error: ${out.text}`;
    }
    return out;
  }
}

/** 子プロセスに渡す最小限の環境変数(PATH 等)。SDK の getDefaultEnvironment と同等 */
function defaultEnv(): Record<string, string> {
  const keys =
    process.platform === 'win32'
      ? [
          'APPDATA',
          'HOMEDRIVE',
          'HOMEPATH',
          'LOCALAPPDATA',
          'PATH',
          'PROCESSOR_ARCHITECTURE',
          'SYSTEMDRIVE',
          'SYSTEMROOT',
          'TEMP',
          'USERNAME',
          'USERPROFILE',
          'PROGRAMFILES',
        ]
      : ['HOME', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER'];
  const env: Record<string, string> = {};
  for (const k of keys) {
    const v = process.env[k];
    if (v !== undefined && !v.startsWith('()')) env[k] = v;
  }
  return env;
}

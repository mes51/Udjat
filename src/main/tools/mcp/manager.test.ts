import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { McpServer, McpServerStatus } from '@shared/schemas';
import { openDatabase, type Database } from '@main/db/client';
import { AttachmentRepository } from '@main/db/repositories/attachments';
import { McpServerRepository } from '@main/db/repositories/mcp-servers';
import { FfmpegService } from '@main/media/ffmpeg';
import { MediaStore } from '@main/media/store';
import { ToolRegistry } from '../registry';
import type { ToolContext } from '../types';
import { McpManager, namespaceOf, qualifiedToolName } from './manager';
import { parseMcpServersJson, toMcpServersJson } from './mcp-config';

const FIXTURE = join(__dirname, 'fixtures', 'echo-server.mjs');

let dir: string;
let db: Database | null = null;
let registry: ToolRegistry;
let manager: McpManager;
let statuses: McpServerStatus[];

const ctx: ToolContext = {
  conversationId: 'c',
  runId: 'r',
  signal: new AbortController().signal,
  counters: new Map(),
  getSetting: () => null,
};

function fixtureServer(overrides: Partial<McpServer> = {}): McpServer {
  return {
    id: 'srv1',
    name: 'Echo Fixture',
    transport: 'stdio',
    config: { command: process.execPath, args: [FIXTURE], env: {} },
    enabled: true,
    autostart: true,
    ...overrides,
  };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'udjat-mcp-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

afterEach(async () => {
  await manager?.disconnectAll();
  if (db) {
    db.close();
    db = null;
  }
});

function setup(withMedia = true) {
  db = openDatabase({ path: ':memory:' });
  registry = new ToolRegistry(db);
  statuses = [];
  const media = withMedia
    ? new MediaStore(new AttachmentRepository(db), new FfmpegService(), {
        mediaDir: join(dir, 'media'),
        cacheDir: join(dir, 'cache'),
      })
    : undefined;
  manager = new McpManager({
    registry,
    ...(media ? { media } : {}),
    onStatusChange: (s) => statuses.push(s),
    requestTimeoutMs: 20_000,
  });
}

describe('namespaceOf', () => {
  it('normalizes server names for tool namespaces', () => {
    expect(namespaceOf('Echo Fixture')).toBe('echo_fixture');
    expect(namespaceOf('  日本語 ')).toBe('mcp');
    expect(qualifiedToolName(fixtureServer(), 'echo')).toBe('echo_fixture__echo');
  });
});

describe('McpManager (stdio)', () => {
  it('connects, registers namespaced tools with ask policy, and calls them', async () => {
    setup();
    const status = await manager.connect(fixtureServer());
    expect(status.state).toBe('connected');
    expect(status.serverName).toBe('echo-fixture');
    expect(status.serverVersion).toBe('1.2.3');
    expect(status.tools.map((t) => t.name).sort()).toEqual([
      'echo_fixture__add',
      'echo_fixture__echo',
      'echo_fixture__fail',
      'echo_fixture__picture',
    ]);
    expect(registry.list().find((t) => t.name === 'echo_fixture__echo')).toMatchObject({
      source: 'mcp',
      policy: 'ask',
    });
    expect(registry.get('echo_fixture__add')?.definition.parameters).toMatchObject({
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
    });

    const echo = await registry.execute('echo_fixture__echo', { text: 'hi' }, ctx);
    expect(echo).toEqual({ text: 'echo: hi' });
    const add = await registry.execute('echo_fixture__add', { a: 2, b: 3 }, ctx);
    expect(add.text).toBe('5');
    const fail = await registry.execute('echo_fixture__fail', {}, ctx);
    expect(fail).toEqual({ text: 'error: boom', isError: true });
    expect(statuses.map((s) => s.state)).toEqual(['connecting', 'connecting', 'connected']);
  }, 30_000);

  it('stores image content as an attachment and exposes it as tool media', async () => {
    setup();
    await manager.connect(fixtureServer());
    const r = await registry.execute('echo_fixture__picture', {}, ctx);
    expect(r.text).toContain('here is a picture');
    expect(r.media).toHaveLength(1);
    expect(r.media![0]).toMatchObject({ mime: 'image/png', kind: 'image' });
  }, 30_000);

  it('disconnects and removes its tools; reports errors for bad commands', async () => {
    setup(false);
    await manager.connect(fixtureServer());
    expect(registry.get('echo_fixture__echo')).toBeDefined();
    await manager.disconnect('srv1');
    expect(registry.get('echo_fixture__echo')).toBeUndefined();
    expect(manager.status(fixtureServer()).state).toBe('disconnected');

    const bad = await manager.connect(
      fixtureServer({
        id: 'bad',
        name: 'bad',
        config: { command: process.execPath, args: ['-e', 'process.exit(3)'], env: {} },
      }),
    );
    expect(bad.state).toBe('error');
    expect(bad.error).toBeTruthy();
  }, 30_000);
});

describe('McpServerRepository', () => {
  it('round-trips stdio and http servers', () => {
    const d = openDatabase({ path: ':memory:' });
    const repo = new McpServerRepository(d);
    const a = repo.create({
      name: 'fs',
      transport: 'stdio',
      config: { command: 'npx', args: ['-y', 'server-filesystem', 'C:\\data'], env: { A: '1' } },
      enabled: true,
      autostart: false,
    });
    const b = repo.create({
      name: 'remote',
      transport: 'http',
      config: { url: 'http://localhost:3333/mcp', headers: { Authorization: 'Bearer x' } },
      enabled: false,
      autostart: false,
    });
    expect(repo.list().map((s) => s.name)).toEqual(['fs', 'remote']);
    expect(repo.get(a.id)?.config).toEqual({
      command: 'npx',
      args: ['-y', 'server-filesystem', 'C:\\data'],
      env: { A: '1' },
    });
    expect(repo.update(b.id, { enabled: true })?.enabled).toBe(true);
    expect(repo.delete(a.id)).toBe(true);
    expect(repo.list()).toHaveLength(1);
    d.close();
  });
});

describe('mcpServers JSON', () => {
  it('parses the Claude Desktop format and serializes back', () => {
    const parsed = parseMcpServersJson(
      JSON.stringify({
        mcpServers: {
          filesystem: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
            env: { X: '1' },
          },
          remote: {
            url: 'https://example.com/mcp',
            headers: { Authorization: 'Bearer t' },
            disabled: true,
          },
          broken: { nothing: true },
        },
      }),
    );
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ name: 'filesystem', transport: 'stdio', enabled: true });
    expect(parsed[1]).toMatchObject({ name: 'remote', transport: 'http', enabled: false });
    const servers = parsed.map((p, i) => ({ ...p, id: String(i) })) as McpServer[];
    const json = JSON.parse(toMcpServersJson(servers)) as { mcpServers: Record<string, unknown> };
    expect(json.mcpServers['filesystem']).toEqual({
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      env: { X: '1' },
    });
    expect(json.mcpServers['remote']).toMatchObject({
      url: 'https://example.com/mcp',
      disabled: true,
    });
    expect(() => parseMcpServersJson('{')).toThrow(/JSON/);
  });
});

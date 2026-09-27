import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type Database } from '@main/db/client';
import { AttachmentRepository } from '@main/db/repositories/attachments';
import { FfmpegService } from '@main/media/ffmpeg';
import { MediaStore } from '@main/media/store';
import { json, startMockServer, type MockServer } from '@main/providers/test-server';
import type { ToolContext } from '../types';
import { createCodeTools, hostAllowed, pathAllowed } from './code';

let dir: string;
let db: Database;
let store: MediaStore;
let server: MockServer;

const ctx: ToolContext = {
  conversationId: 'c1',
  runId: 'r',
  signal: new AbortController().signal,
  counters: new Map(),
  getSetting: () => null,
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'udjat-code-'));
  db = openDatabase({ path: ':memory:' });
  store = new MediaStore(new AttachmentRepository(db), new FfmpegService(), {
    mediaDir: join(dir, 'media'),
    cacheDir: join(dir, 'cache'),
  });
  writeFileSync(join(dir, 'data.txt'), 'line1\nline2\n');
  server = await startMockServer({
    'GET /api': (_r, _b, res) => json(res, { hello: 'world' }),
  });
});

afterAll(async () => {
  await server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('path / host matching', () => {
  it('matches files under declared directories and exact files', () => {
    expect(pathAllowed(join(dir, 'data.txt'), [dir])).toBe(true);
    expect(pathAllowed(join(dir, 'sub', 'x.txt'), [dir])).toBe(true);
    expect(pathAllowed(join(dir, 'data.txt'), [join(dir, 'data.txt')])).toBe(true);
    expect(pathAllowed(join(dir, 'other.txt'), [join(dir, 'data.txt')])).toBe(false);
    expect(pathAllowed(join(dir, '..', 'escape.txt'), [dir])).toBe(false);
    expect(pathAllowed(dir + '-sibling', [dir])).toBe(false);
  });

  it('matches hosts, wildcards and ports', () => {
    expect(hostAllowed(new URL('https://example.com/x'), ['example.com'])).toBe(true);
    expect(hostAllowed(new URL('https://api.example.com/x'), ['example.com'])).toBe(false);
    expect(hostAllowed(new URL('https://api.example.com/x'), ['*.example.com'])).toBe(true);
    expect(hostAllowed(new URL('https://example.com/x'), ['*.example.com'])).toBe(false);
    expect(hostAllowed(new URL('http://127.0.0.1:8080/x'), ['127.0.0.1:8080'])).toBe(true);
    expect(hostAllowed(new URL('http://127.0.0.1:8081/x'), ['127.0.0.1:8080'])).toBe(false);
    expect(hostAllowed(new URL('https://example.com/x'), ['https://example.com/'])).toBe(true);
  });
});

describe('run_javascript tool', () => {
  const tool = () => createCodeTools({ store })[0]!;

  it('requires approval only when permissions are declared', () => {
    const t = tool();
    expect(t.category).toBe('code');
    expect(t.defaultPolicy).toBe('ask');
    expect(t.requiresApproval!({ code: '1' })).toBe(false);
    expect(t.requiresApproval!({ code: '1', allow_read: [] })).toBe(false);
    expect(t.requiresApproval!({ code: '1', allow_read: ['C:/x'] })).toBe(true);
    expect(t.requiresApproval!({ code: '1', allow_net: ['example.com'] })).toBe(true);
  });

  it('runs code and returns console output and result as JSON', async () => {
    const r = await tool().execute({ code: 'console.log("hi"); return 6 * 7;' }, ctx);
    expect(r.isError).toBeFalsy();
    const out = JSON.parse(r.text) as { ok: boolean; result: number; stdout: string };
    expect(out.ok).toBe(true);
    expect(out.result).toBe(42);
    expect(out.stdout).toBe('hi\n');
  });

  it('denies file access outside allow_read and permits it inside', async () => {
    const file = join(dir, 'data.txt');
    const code = `return await udjat.readFile(${JSON.stringify(file)});`;
    const denied = JSON.parse((await tool().execute({ code }, ctx)).text) as {
      ok: boolean;
      error: string;
    };
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain('permission denied');
    expect(denied.error).toContain('allow_read');

    const allowed = JSON.parse((await tool().execute({ code, allow_read: [dir] }, ctx)).text) as {
      ok: boolean;
      result: string;
    };
    expect(allowed.ok).toBe(true);
    expect(allowed.result).toBe('line1\nline2\n');
  });

  it('writes files only under allow_write and lists directories', async () => {
    const out = join(dir, 'out.txt');
    const code = `await udjat.writeFile(${JSON.stringify(out)}, 'written by sandbox'); return (await udjat.readDir(${JSON.stringify(dir)})).map(e => e.name).sort();`;
    const denied = JSON.parse((await tool().execute({ code, allow_read: [dir] }, ctx)).text) as {
      ok: boolean;
    };
    expect(denied.ok).toBe(false);
    expect(existsSync(out)).toBe(false);
    const allowed = JSON.parse(
      (await tool().execute({ code, allow_read: [dir], allow_write: [out] }, ctx)).text,
    ) as { ok: boolean; result: string[] };
    expect(allowed.ok).toBe(true);
    expect(readFileSync(out, 'utf8')).toBe('written by sandbox');
    expect(allowed.result).toContain('data.txt');
    expect(allowed.result).toContain('out.txt');
  });

  it('fetches only declared hosts', async () => {
    const url = `${server.url}/api`;
    const code = `const r = await udjat.fetch(${JSON.stringify(url)}); return [r.status, JSON.parse(r.text).hello];`;
    const denied = JSON.parse((await tool().execute({ code }, ctx)).text) as {
      ok: boolean;
      error: string;
    };
    expect(denied.ok).toBe(false);
    expect(denied.error).toContain('allow_net');
    const host = new URL(server.url).host;
    const allowed = JSON.parse((await tool().execute({ code, allow_net: [host] }, ctx)).text) as {
      ok: boolean;
      result: unknown[];
    };
    expect(allowed.ok).toBe(true);
    expect(allowed.result).toEqual([200, 'world']);
  });

  it('exposes attachments without permissions', async () => {
    const csvPath = join(dir, 'table.csv');
    writeFileSync(csvPath, 'a,b\n1,2\n');
    const a = await store.addFile(csvPath);
    const code = `const t = await udjat.readAttachment(${JSON.stringify(a.id)}); return t.split('\\n').length;`;
    const r = JSON.parse((await tool().execute({ code }, ctx)).text) as {
      ok: boolean;
      result: number;
    };
    expect(r.ok).toBe(true);
    expect(r.result).toBe(3);
  });

  it('adds a rewrite hint when Node-style globals are used, and serves the reference', async () => {
    const [runJs, reference] = createCodeTools({ store });
    const r = await runJs!.execute({ code: `const fs = require('fs'); return fs;` }, ctx);
    expect(r.isError).toBe(true);
    const payload = JSON.parse(r.text) as { error: string };
    expect(payload.error).toContain("ReferenceError: 'require' is not defined");
    expect(payload.error).toContain('ヒント: require / import は使えません');
    expect(payload.error).toContain('js_sandbox_reference');
    const ref = await reference!.execute({}, ctx);
    expect(ref.text).toContain('QuickJS');
    expect(ref.text).toContain('udjat.readFile');
    expect(runJs!.definition.description).toContain('QuickJS');
    expect(runJs!.background?.({ background: true })).toBe(true);
    expect(runJs!.background?.({})).toBe(false);
  });

  it('rejects relative paths in allow_* and reports timeouts', async () => {
    const rel = await tool().execute({ code: 'return 1', allow_read: ['relative/path'] }, ctx);
    expect(rel.isError).toBe(true);
    const t = JSON.parse(
      (await tool().execute({ code: 'while (true) {}', timeout_ms: 1000 }, ctx)).text,
    ) as { ok: boolean; error: string };
    expect(t.ok).toBe(false);
    expect(t.error).toMatch(/timeout|interrupted/);
  });
});

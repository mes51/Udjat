import { describe, expect, it } from 'vitest';
import { runJavaScript, type SandboxHost } from './js-sandbox';

const denyAll: SandboxHost = {
  readFile: async (p) => {
    throw new Error(`permission denied: read ${p}`);
  },
  writeFile: async (p) => {
    throw new Error(`permission denied: write ${p}`);
  },
  readDir: async (p) => {
    throw new Error(`permission denied: readdir ${p}`);
  },
  fetch: async (u) => {
    throw new Error(`permission denied: fetch ${u}`);
  },
  listAttachments: async () => [],
  readAttachment: async (id) => {
    throw new Error(`attachment not found: ${id}`);
  },
};

describe('js sandbox', () => {
  it('runs code, captures console output and returns the returned value', async () => {
    const r = await runJavaScript(
      `console.log('hello', { a: 1 }); console.error('warn!');\nconst xs = [1,2,3].map(x => x * 2);\nreturn { sum: xs.reduce((a, b) => a + b, 0), xs };`,
      { timeoutMs: 5000, host: denyAll },
    );
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe('hello {"a":1}\n');
    expect(r.stderr).toBe('warn!\n');
    expect(r.result).toEqual({ sum: 12, xs: [2, 4, 6] });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('supports top-level await and reports thrown errors with a stack', async () => {
    const r = await runJavaScript(`await Promise.resolve(); throw new TypeError('boom');`, {
      timeoutMs: 5000,
      host: denyAll,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('TypeError: boom');
    expect(r.error).toContain('main.js');
  });

  it('has no access to node globals', async () => {
    const r = await runJavaScript(
      `return [typeof require, typeof process, typeof XMLHttpRequest, typeof globalThis.__host_call, typeof udjat.readFile];`,
      { timeoutMs: 5000, host: denyAll },
    );
    expect(r.result).toEqual(['undefined', 'undefined', 'undefined', 'function', 'function']);
  });

  it('exposes a Web-style global fetch that goes through the host', async () => {
    const seen: { url: string; init: unknown }[] = [];
    const r = await runJavaScript(
      `const res = await fetch('https://api.example.com/items', { method: 'POST', headers: { 'X-Token': 'abc' }, body: { q: 1 } });
       const data = await res.json();
       const plain = await fetch('https://api.example.com/text');
       let denied = null;
       try { await fetch('https://evil.example/'); } catch (e) { denied = e.message; }
       return { status: res.status, ok: res.ok, ct: res.headers.get('Content-Type'), data, text: await plain.text(), denied };`,
      {
        timeoutMs: 5000,
        host: {
          ...denyAll,
          fetch: async (url, init) => {
            if (url.includes('evil')) throw new Error('permission denied: fetch evil.example');
            seen.push({ url, init });
            return url.endsWith('/items')
              ? {
                  status: 201,
                  headers: { 'Content-Type': 'application/json' },
                  text: '{"id":7}',
                  truncated: false,
                }
              : { status: 200, headers: {}, text: 'plain body', truncated: false };
          },
        },
      },
    );
    expect(r.error).toBeUndefined();
    expect(r.result).toEqual({
      status: 201,
      ok: true,
      ct: 'application/json',
      data: { id: 7 },
      text: 'plain body',
      denied: 'permission denied: fetch evil.example',
    });
    // オブジェクトの body は JSON 文字列にし、content-type を補う。ヘッダ名は小文字に揃える
    expect(seen[0]).toEqual({
      url: 'https://api.example.com/items',
      init: {
        method: 'POST',
        headers: { 'x-token': 'abc', 'content-type': 'application/json' },
        body: '{"q":1}',
      },
    });
  });

  it('provides timers, sleep, callTool, TextEncoder and atob/btoa', async () => {
    const calls: string[] = [];
    const r = await runJavaScript(
      `const t0 = Date.now();
       await udjat.sleep(30);
       const viaTimeout = await new Promise((res) => setTimeout(() => res('timer'), 20));
       const id = setTimeout(() => { throw new Error('should not fire'); }, 10);
       clearTimeout(id);
       let ticks = 0;
       const iv = setInterval(() => { ticks++; if (ticks === 3) clearInterval(iv); }, 5);
       await udjat.sleep(60);
       const tool = await udjat.callTool('current_datetime', {});
       let denied = null;
       try { await udjat.callTool('fs_write', { path: 'x' }); } catch (e) { denied = e.message; }
       const bytes = new TextEncoder().encode('日本語 ok');
       const back = new TextDecoder().decode(bytes);
       return { waited: Date.now() - t0 >= 30, viaTimeout, ticks, tool, denied, len: bytes.length, back, b64: btoa('hi'), un: atob('aGk=') };`,
      {
        timeoutMs: 5000,
        host: {
          ...denyAll,
          callTool: async (name, args) => {
            calls.push(`${name} ${JSON.stringify(args)}`);
            return name === 'fs_write'
              ? { text: 'error: requires approval', isError: true }
              : { text: '{"iso":"2026-09-27"}', isError: false };
          },
        },
      },
    );
    expect(r.error).toBeUndefined();
    expect(r.result).toEqual({
      waited: true,
      viaTimeout: 'timer',
      ticks: 3,
      tool: { iso: '2026-09-27' },
      denied: 'error: requires approval',
      len: 12,
      back: '日本語 ok',
      b64: 'aGk=',
      un: 'hi',
    });
    expect(calls).toEqual(['current_datetime {}', 'fs_write {"path":"x"}']);
  });

  it('interrupts infinite loops at the deadline', async () => {
    const r = await runJavaScript(`let i = 0; while (true) i++;`, {
      timeoutMs: 500,
      host: denyAll,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timeout|interrupted/);
    expect(r.durationMs).toBeLessThan(5000);
  });

  it('enforces the memory limit', async () => {
    const r = await runJavaScript(
      `const a = []; for (let i = 0; i < 1e7; i++) a.push({ i, s: 'x'.repeat(100) }); return a.length;`,
      { timeoutMs: 10_000, host: denyAll, memoryBytes: 16 * 1024 * 1024 },
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/out of memory|InternalError|timeout/i);
  });

  it('routes host calls through the host and surfaces permission errors to the code', async () => {
    const calls: string[] = [];
    const host: SandboxHost = {
      ...denyAll,
      readFile: async (p, enc) => {
        calls.push(`read ${p} ${enc}`);
        return enc === 'base64' ? Buffer.from('bin').toString('base64') : 'text content';
      },
      writeFile: async (p, data, enc) => {
        calls.push(`write ${p} ${enc} ${data}`);
      },
      readDir: async () => [{ name: 'a.txt', type: 'file' }],
      fetch: async (url, init) => ({
        status: 200,
        headers: { 'content-type': 'text/plain' },
        text: `fetched ${url} ${init?.method ?? 'GET'}`,
        truncated: false,
      }),
      listAttachments: async () => [
        { id: 'att1', name: 'x.csv', mime: 'text/csv', size: 3, kind: 'file' },
      ],
      readAttachment: async (id) => `csv for ${id}`,
    };
    const r = await runJavaScript(
      `const t = await udjat.readFile('C:/data/a.txt');
       const bytes = await udjat.readFile('C:/data/a.bin', 'buffer');
       await udjat.writeFile('C:/out/b.txt', 'written');
       await udjat.writeFile('C:/out/b.bin', new Uint8Array([104, 105]));
       const dir = await udjat.readDir('C:/data');
       const res = await udjat.fetch('https://example.com/x', { method: 'POST' });
       const atts = await udjat.attachments();
       const csv = await udjat.readAttachment(atts[0].id);
       let denied = null;
       try { await udjat.fetch('https://evil.example'); } catch (e) { denied = e.message; }
       return { t, bytes: Array.from(bytes), dir, res: res.text, atts: atts.length, csv, denied };`,
      {
        timeoutMs: 5000,
        host: {
          ...host,
          fetch: async (url, init) =>
            url.includes('evil')
              ? Promise.reject(new Error('permission denied: fetch evil.example'))
              : host.fetch(url, init),
        },
      },
    );
    expect(r.error).toBeUndefined();
    expect(r.result).toEqual({
      t: 'text content',
      bytes: [98, 105, 110],
      dir: [{ name: 'a.txt', type: 'file' }],
      res: 'fetched https://example.com/x POST',
      atts: 1,
      csv: 'csv for att1',
      denied: 'permission denied: fetch evil.example',
    });
    expect(calls).toEqual([
      'read C:/data/a.txt utf8',
      'read C:/data/a.bin base64',
      'write C:/out/b.txt utf8 written',
      'write C:/out/b.bin base64 aGk=',
    ]);
  });

  it('truncates huge output and results', async () => {
    const r = await runJavaScript(
      `for (let i = 0; i < 2000; i++) console.log('x'.repeat(100)); return 'y'.repeat(100000);`,
      { timeoutMs: 5000, host: denyAll, maxOutputChars: 1000, maxResultChars: 500 },
    );
    expect(r.ok).toBe(true);
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(1000);
    expect(String(r.result).length).toBeLessThanOrEqual(500);
  });
});

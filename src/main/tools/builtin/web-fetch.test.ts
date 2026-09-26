import { afterEach, describe, expect, it } from 'vitest';
import { startMockServer, type MockServer } from '@main/providers/test-server';
import { checkUrl, isPrivateIp } from './net-guard';
import { fetchAsMarkdown, htmlToMarkdown } from './web-fetch';

let server: MockServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe('net-guard', () => {
  it('classifies private addresses', () => {
    for (const ip of [
      '10.0.0.1',
      '127.0.0.1',
      '192.168.1.20',
      '172.16.5.5',
      '169.254.1.1',
      '::1',
      'fe80::1',
      '::ffff:10.0.0.1',
    ]) {
      expect(isPrivateIp(ip), ip).toBe(true);
    }
    for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111'])
      expect(isPrivateIp(ip), ip).toBe(false);
  });

  it('rejects private targets unless allow-listed, and resolves hostnames', async () => {
    expect(await checkUrl('http://192.168.1.20:8888/v1/models')).toMatchObject({ ok: false });
    expect(await checkUrl('http://localhost:8080/')).toMatchObject({ ok: false });
    expect(await checkUrl('ftp://example.com/')).toMatchObject({ ok: false });
    expect(
      await checkUrl('http://192.168.1.20:8888/', { allowHosts: ['192.168.1.20'] }),
    ).toMatchObject({ ok: true });
    expect(
      await checkUrl('https://evil.example/', { resolve: async () => ['10.1.1.1'] }),
    ).toMatchObject({ ok: false });
    expect(
      await checkUrl('https://good.example/', { resolve: async () => ['93.184.216.34'] }),
    ).toMatchObject({ ok: true });
  });
});

describe('htmlToMarkdown', () => {
  it('extracts the article and converts to markdown', () => {
    const html = `<html><head><title>Sample Title</title></head><body>
      <nav>menu menu menu</nav>
      <article><h1>Heading</h1><p>${'Paragraph text. '.repeat(30)}</p>
      <ul><li>${'first item with enough words to survive cleanup. '.repeat(3)}</li><li>${'second item with enough words to survive cleanup. '.repeat(3)}</li></ul>
      <pre><code>const x = 1;</code></pre><script>alert(1)</script></article></body></html>`;
    const r = htmlToMarkdown(html, 'https://example.com/a');
    expect(r.title).toContain('Sample Title');
    expect(r.markdown).toMatch(/Heading/);
    expect(r.markdown).toMatch(/-\s+first item/);
    expect(r.markdown).toContain('const x = 1;');
    expect(r.markdown).not.toContain('alert(1)');
  });
});

describe('fetchAsMarkdown', () => {
  it('fetches HTML from an allow-listed host, converts it and truncates', async () => {
    server = await startMockServer({
      'GET /page': (_r, _b, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          `<html><head><title>T</title></head><body><article><p>${'日本語の本文。'.repeat(200)}</p></article></body></html>`,
        );
      },
      'GET /data.json': (_r, _b, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"a":1}');
      },
      'GET /bin': (_r, _b, res) => {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        res.end('xx');
      },
    });
    const host = new URL(server.url).host;
    const signal = new AbortController().signal;
    const page = await fetchAsMarkdown(`${server.url}/page`, {
      maxChars: 300,
      signal,
      allowHosts: [host],
    });
    expect(page.isError).toBeUndefined();
    expect(page.text).toMatch(/^# T/);
    expect(page.text).toContain('先頭 300 文字');
    const json = await fetchAsMarkdown(`${server.url}/data.json`, {
      maxChars: 1000,
      signal,
      allowHosts: [host],
    });
    expect(json.text).toContain('"a": 1');
    const bin = await fetchAsMarkdown(`${server.url}/bin`, {
      maxChars: 1000,
      signal,
      allowHosts: [host],
    });
    expect(bin.isError).toBe(true);
    const blocked = await fetchAsMarkdown(`${server.url}/page`, { maxChars: 1000, signal });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toMatch(/プライベート/);
  });
});

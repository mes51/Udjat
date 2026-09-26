import { afterEach, describe, expect, it } from 'vitest';
import { classifyFetchError, request, requestJson } from './http';
import { ProviderError } from './types';
import { json, startMockServer, type MockServer } from './test-server';

let server: MockServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

describe('classifyFetchError', () => {
  it('maps ECONNREFUSED to a refused error with a LAN-binding hint', () => {
    const e = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED 192.168.1.20:8888'), {
        code: 'ECONNREFUSED',
      }),
    });
    const err = classifyFetchError(e, 'http://192.168.1.20:8888/v1/models');
    expect(err.code).toBe('refused');
    expect(err.message).toMatch(/127\.0\.0\.1|ポート番号/);
  });

  it('maps timeouts and DNS failures', () => {
    expect(classifyFetchError(new Error('timeout after 15000ms'), 'u').code).toBe('timeout');
    const dns = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('getaddrinfo ENOTFOUND host'), { code: 'ENOTFOUND' }),
    });
    expect(classifyFetchError(dns, 'u').code).toBe('dns');
  });
});

describe('request / requestJson', () => {
  it('turns 401 into an unauthorized error with an API key hint', async () => {
    server = await startMockServer({
      'GET /v1/models': (_r, _b, res) => json(res, { error: 'invalid api key' }, 401),
    });
    await expect(request(server.profile('openai-compatible'), '/v1/models')).rejects.toMatchObject({
      code: 'unauthorized',
      status: 401,
    });
  });

  it('sends the API key as a Bearer token', async () => {
    let auth = '';
    server = await startMockServer({
      'GET /v1/models': (req, _b, res) => {
        auth = req.headers.authorization ?? '';
        json(res, { data: [] });
      },
    });
    await request(
      { ...server.profile('openai-compatible'), apiKey: ' sk-unsloth-abc ' },
      '/v1/models',
    );
    expect(auth).toBe('Bearer sk-unsloth-abc');
  });

  it('reports non-JSON responses (e.g. a web UI page) clearly', async () => {
    server = await startMockServer({
      'GET /v1/models': (_r, _b, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<!doctype html><html><body>Studio</body></html>');
      },
    });
    const err = await requestJson(server.profile('openai-compatible'), '/v1/models').catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe('not-json');
  });

  it('refuses to connect to a closed port with a refused error', async () => {
    const s = await startMockServer({});
    const profile = s.profile('openai-compatible');
    await s.close();
    const err = await request(profile, '/v1/models').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect((err as ProviderError).code).toBe('refused');
  });
});

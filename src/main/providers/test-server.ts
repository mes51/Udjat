import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ServerKind, ServerProfile } from '@shared/schemas';

/** テスト用のモック LLM サーバー。ルートごとにハンドラを登録する。 */

export type Handler = (
  req: IncomingMessage,
  body: unknown,
  res: ServerResponse,
) => void | Promise<void>;

export interface MockServer {
  url: string;
  profile: (kind: ServerKind) => ServerProfile;
  requests: { method: string; path: string; body: unknown }[];
  close: () => Promise<void>;
}

export async function startMockServer(routes: Record<string, Handler>): Promise<MockServer> {
  const requests: MockServer['requests'] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString('utf8')));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as unknown) : undefined;
      const path = req.url ?? '/';
      requests.push({ method: req.method ?? 'GET', path, body });
      const h = routes[`${req.method} ${path}`] ?? routes[path];
      if (!h) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `no route for ${req.method} ${path}` }));
        return;
      }
      void h(req, body, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    requests,
    profile: (kind) => ({
      id: 'p1',
      name: 'mock',
      kind,
      baseUrl: url,
      apiKey: null,
      defaultModel: null,
      defaultParams: {},
      capabilityOverrides: {},
      createdAt: 0,
      updatedAt: 0,
    }),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

export function sse(res: ServerResponse, chunks: unknown[], opts: { done?: boolean } = {}): void {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
  if (opts.done !== false) res.write('data: [DONE]\n\n');
  res.end();
}

export function ndjson(res: ServerResponse, chunks: unknown[]): void {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
  for (const c of chunks) res.write(`${JSON.stringify(c)}\n`);
  res.end();
}

export function json(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

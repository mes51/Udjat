// テスト用の最小 MCP サーバー(stdio)。echo / add / picture / fail の 4 ツールを提供する。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'echo-fixture', version: '1.2.3' });

server.registerTool(
  'echo',
  { description: 'Echo the text back', inputSchema: { text: z.string() } },
  async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }),
);
server.registerTool(
  'add',
  { description: 'Add two numbers', inputSchema: { a: z.number(), b: z.number() } },
  async ({ a, b }) => ({
    content: [{ type: 'text', text: String(a + b) }],
    structuredContent: { sum: a + b },
  }),
);
// 1x1 の PNG
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
server.registerTool(
  'picture',
  { description: 'Return a tiny image', inputSchema: {} },
  async () => ({
    content: [
      { type: 'text', text: 'here is a picture' },
      { type: 'image', data: PNG, mimeType: 'image/png' },
    ],
  }),
);
server.registerTool('fail', { description: 'Always fails', inputSchema: {} }, async () => ({
  content: [{ type: 'text', text: 'boom' }],
  isError: true,
}));

await server.connect(new StdioServerTransport());

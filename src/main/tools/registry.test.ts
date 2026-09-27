import { describe, expect, it } from 'vitest';
import { openDatabase } from '@main/db/client';
import { guessFromModelName } from '@main/providers';
import { parseToolArgs, ToolRegistry } from './registry';
import type { RegisteredTool, ToolContext } from './types';
import { ok } from './types';

const ctx: ToolContext = {
  conversationId: 'c',
  runId: 'r',
  signal: new AbortController().signal,
  counters: new Map(),
  getSetting: () => null,
};

function tool(name: string, extra: Partial<RegisteredTool> = {}): RegisteredTool {
  return {
    definition: { name, description: name, parameters: { type: 'object', properties: {} } },
    source: { kind: 'builtin' },
    category: 'basic',
    defaultPolicy: 'auto',
    execute: async (args) => ok(JSON.stringify(args)),
    ...extra,
  };
}

describe('ToolRegistry', () => {
  it('persists policies and filters definitions by capability, enabled list and deny policy', () => {
    const db = openDatabase({ path: ':memory:' });
    const r = new ToolRegistry(db);
    r.register(tool('a'));
    r.register(tool('b', { defaultPolicy: 'ask' }));
    r.register(tool('video_clip', { requires: { video: 'native' }, category: 'video' }));

    expect(r.policyFor('b')).toBe('ask');
    r.setPolicy('b', 'deny');
    expect(r.policyFor('b')).toBe('deny');
    r.setPolicy('b', null);
    expect(r.policyFor('b')).toBe('ask');
    expect(r.list().map((t) => [t.category, t.categoryLabel])).toEqual([
      ['basic', '基本'],
      ['basic', '基本'],
      ['video', '動画'],
    ]);

    const caps = guessFromModelName('ollama', 'qwen3:8b');
    expect(r.definitionsFor(caps).map((d) => d.name)).toEqual(['a', 'b']);
    const native = { ...caps, video: 'native' as const };
    expect(r.definitionsFor(native).map((d) => d.name)).toEqual(['a', 'b', 'video_clip']);
    expect(
      r.definitionsFor(caps, { disabledCategories: [], disabledTools: ['a'] }).map((d) => d.name),
    ).toEqual(['b']);
    expect(
      r
        .definitionsFor(native, { disabledCategories: ['video'], disabledTools: [] })
        .map((d) => d.name),
    ).toEqual(['a', 'b']);
    r.setPolicy('a', 'deny');
    expect(r.definitionsFor(caps).map((d) => d.name)).toEqual(['b']);
    db.close();
  });

  it('converts thrown errors into error results', async () => {
    const db = openDatabase({ path: ':memory:' });
    const r = new ToolRegistry(db);
    r.register(
      tool('boom', {
        execute: async () => {
          throw new TypeError('bad');
        },
      }),
    );
    expect(await r.execute('boom', {}, ctx)).toEqual({
      text: 'error: TypeError: bad',
      isError: true,
    });
    expect(await r.execute('nope', {}, ctx)).toMatchObject({ isError: true });
    db.close();
  });
});

describe('parseToolArgs', () => {
  it('parses objects and reports broken JSON', () => {
    expect(parseToolArgs('{"a":1}')).toEqual({ args: { a: 1 } });
    expect(parseToolArgs('')).toEqual({ args: {} });
    expect(parseToolArgs('[1]').error).toMatch(/object/);
    expect(parseToolArgs('{oops').error).toMatch(/invalid JSON/);
  });
});

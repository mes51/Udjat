import { describe, expect, it } from 'vitest';
import { parseNdjson, parseSse } from './stream-parsers';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe('parseSse', () => {
  it('parses events split across arbitrary chunk boundaries', async () => {
    const text =
      'data: {"a":1}\n\ndata: {"b":\ndata: 2}\n\n: comment\nevent: usage\ndata: [DONE]\n\n';
    const chunks = [text.slice(0, 7), text.slice(7, 20), text.slice(20)];
    const events = await collect(parseSse(streamOf(chunks)));
    expect(events).toEqual([
      { data: '{"a":1}' },
      { data: '{"b":\n2}' },
      { event: 'usage', data: '[DONE]' },
    ]);
  });

  it('handles CRLF and a final event without trailing blank line', async () => {
    const events = await collect(parseSse(streamOf(['data: x\r\n\r\ndata: y'])));
    expect(events).toEqual([{ data: 'x' }, { data: 'y' }]);
  });

  it('decodes multi-byte characters split across chunks', async () => {
    const enc = new TextEncoder().encode('data: こんにちは\n\n');
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.slice(0, 9)); // 「こ」の途中で切る
        c.enqueue(enc.slice(9));
        c.close();
      },
    });
    const events = await collect(parseSse(stream));
    expect(events).toEqual([{ data: 'こんにちは' }]);
  });
});

describe('parseNdjson', () => {
  it('yields one object per line and skips blank lines', async () => {
    const objs = await collect(parseNdjson(streamOf(['{"n":1}\n\n{"n":', '2}\n{"n":3}'])));
    expect(objs).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
  });
});

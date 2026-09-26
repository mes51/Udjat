/**
 * SSE / NDJSON のストリームパーサ。fetch の body(ReadableStream<Uint8Array>)を
 * 行単位に分解し、イベント/JSON オブジェクトとして順次返す。
 */

async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        let line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        yield line;
      }
    }
    buf += decoder.decode();
    if (buf.length > 0) yield buf;
  } finally {
    reader.releaseLock();
  }
}

export interface SseEvent {
  event?: string;
  data: string;
}

/** text/event-stream をイベント単位で返す。`data:` が複数行なら改行で連結する。 */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  let event: string | undefined;
  let data: string[] = [];
  for await (const line of lines(body)) {
    if (line === '') {
      if (data.length > 0) {
        const ev: SseEvent = { data: data.join('\n') };
        if (event !== undefined) ev.event = event;
        yield ev;
      }
      event = undefined;
      data = [];
      continue;
    }
    if (line.startsWith(':')) continue; // コメント
    const colon = line.indexOf(':');
    const field = colon >= 0 ? line.slice(0, colon) : line;
    let value = colon >= 0 ? line.slice(colon + 1) : '';
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
    // id / retry は無視
  }
  if (data.length > 0) {
    const ev: SseEvent = { data: data.join('\n') };
    if (event !== undefined) ev.event = event;
    yield ev;
  }
}

/** application/x-ndjson を 1 行 1 オブジェクトで返す。空行は無視する。 */
export async function* parseNdjson<T = unknown>(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<T> {
  for await (const line of lines(body)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    yield JSON.parse(trimmed) as T;
  }
}

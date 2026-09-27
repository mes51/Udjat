import variant from '@jitl/quickjs-singlefile-cjs-release-sync';
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSWASMModule,
} from 'quickjs-emscripten-core';

/**
 * QuickJS(WASM)で LLM のコードを実行するサンドボックス(M11)。
 * WASM の中からホストに触る経路は、ここで注入する __host_log / __host_call だけ。
 * 値の受け渡しはすべて JSON 文字列(バイナリは base64)にして、ハンドル管理を単純にしている。
 */

export interface SandboxHost {
  readFile(path: string, encoding: 'utf8' | 'base64'): Promise<string>;
  writeFile(path: string, data: string, encoding: 'utf8' | 'base64'): Promise<void>;
  readDir(path: string): Promise<{ name: string; type: string }[]>;
  fetch(
    url: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<{
    status: number;
    headers: Record<string, string>;
    text: string;
    truncated: boolean;
    /** バイナリ応答(画像など)の時は base64 で返す(text は空) */
    base64?: string;
  }>;
  /** URL を添付ストアに取り込む(M18)。画像はツール結果の media になる */
  download?(
    url: string,
    opts: { maxBytes?: number; name?: string; saveTo?: string },
  ): Promise<Record<string, unknown>>;
  listAttachments(): Promise<
    { id: string; name: string; mime: string; size: number; kind: string }[]
  >;
  readAttachment(id: string, encoding: 'utf8' | 'base64'): Promise<string>;
  /** 待機(M16: ポーリングを 1 回の呼び出しに閉じ込めるため)。省略時はホスト側の setTimeout */
  sleep?(ms: number): Promise<void>;
  /** 他のツールを呼ぶ(M16)。省略時はエラー */
  callTool?(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError: boolean }>;
}

export interface RunOptions {
  timeoutMs: number;
  host: SandboxHost;
  signal?: AbortSignal | undefined;
  memoryBytes?: number;
  /** stdout / stderr それぞれの上限(バイトではなく文字数) */
  maxOutputChars?: number;
  /** result の JSON 上限 */
  maxResultChars?: number;
}

export interface RunResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  stdout: string;
  stderr: string;
  durationMs: number;
  truncated: boolean;
}

let modulePromise: Promise<QuickJSWASMModule> | null = null;
function getModule(): Promise<QuickJSWASMModule> {
  modulePromise ??= newQuickJSWASMModuleFromVariant(variant);
  return modulePromise;
}

/** サンドボックス側の標準 API(console / udjat)。ホスト関数を JSON 経由で包む */
const PRELUDE = String.raw`
(() => {
  const fmt = (v) => {
    if (typeof v === 'string') return v;
    if (v instanceof Error) return v.stack || String(v);
    if (typeof v === 'bigint') return v.toString() + 'n';
    try { const s = JSON.stringify(v); return s === undefined ? String(v) : s; } catch { return String(v); }
  };
  const emit = (level) => (...a) => { __host_log(level, a.map(fmt).join(' ')); };
  globalThis.console = Object.freeze({
    log: emit('out'), info: emit('out'), debug: emit('out'), warn: emit('err'), error: emit('err'),
  });
  const call = (name, args) => __host_call(name, JSON.stringify(args)).then((s) => {
    const r = JSON.parse(s);
    if (r.ok) return r.value;
    throw new Error(r.error);
  });
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const b64decode = (s) => {
    const clean = s.replace(/[^A-Za-z0-9+/]/g, '');
    const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
    let o = 0, buf = 0, bits = 0;
    for (const ch of clean) {
      buf = (buf << 6) | B64.indexOf(ch); bits += 6;
      if (bits >= 8) { bits -= 8; out[o++] = (buf >> bits) & 0xff; }
    }
    return out.subarray(0, o);
  };
  const b64encode = (bytes) => {
    let s = '', i = 0;
    for (; i + 2 < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      s += B64[n >> 18] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
    }
    if (i < bytes.length) {
      const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8);
      s += B64[n >> 18] + B64[(n >> 12) & 63] + (i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=') + '=';
    }
    return s;
  };
  const readAs = (name, key) => (target, encoding = 'utf8') => {
    if (encoding === 'buffer' || encoding === 'bytes')
      return call(name, { [key]: target, encoding: 'base64' }).then(b64decode);
    if (encoding !== 'utf8' && encoding !== 'base64') return Promise.reject(new Error('encoding must be utf8 | base64 | buffer'));
    return call(name, { [key]: target, encoding });
  };
  globalThis.udjat = Object.freeze({
    readFile: readAs('readFile', 'path'),
    writeFile: (path, data) => {
      if (data instanceof Uint8Array) return call('writeFile', { path, data: b64encode(data), encoding: 'base64' });
      return call('writeFile', { path, data: typeof data === 'string' ? data : fmt(data), encoding: 'utf8' });
    },
    readDir: (path) => call('readDir', { path }),
    fetch: (url, init) => call('fetch', { url, init: normalizeInit(init) }),
    attachments: () => call('listAttachments', {}),
    readAttachment: readAs('readAttachment', 'id'),
    base64: Object.freeze({ encode: b64encode, decode: b64decode }),
    sleep: (ms) => call('sleep', { ms: Math.max(0, Number(ms) || 0) }),
    download: (url, opts) => call('download', { url: String(url), opts: opts && typeof opts === 'object' ? opts : {} }),
    callTool: (name, args) => call('callTool', { name: String(name), args: args && typeof args === 'object' ? args : {} }).then((r) => {
      if (r.isError) throw new Error(r.text);
      try { return JSON.parse(r.text); } catch { return r.text; }
    }),
  });
  // タイマー(ホストの setTimeout で待つ。推論は走らない)
  let nextTimer = 1;
  const timers = new Map();
  globalThis.setTimeout = (fn, ms, ...args) => {
    const id = nextTimer++;
    timers.set(id, true);
    udjat.sleep(ms).then(() => { if (timers.delete(id)) fn(...args); });
    return id;
  };
  globalThis.clearTimeout = (id) => { timers.delete(id); };
  globalThis.setInterval = (fn, ms, ...args) => {
    const id = nextTimer++;
    timers.set(id, true);
    const tick = () => udjat.sleep(ms).then(() => { if (timers.has(id)) { fn(...args); tick(); } });
    tick();
    return id;
  };
  globalThis.clearInterval = globalThis.clearTimeout;
  // UTF-8 の TextEncoder / TextDecoder と atob / btoa(最低限)
  const utf8encode = (str) => {
    const out = [];
    for (const ch of String(str)) {
      let c = ch.codePointAt(0);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  };
  const utf8decode = (bytes) => {
    let s = '';
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    for (let i = 0; i < b.length; ) {
      const c = b[i];
      let cp, n;
      if (c < 0x80) { cp = c; n = 1; }
      else if (c < 0xe0) { cp = ((c & 31) << 6) | (b[i + 1] & 63); n = 2; }
      else if (c < 0xf0) { cp = ((c & 15) << 12) | ((b[i + 1] & 63) << 6) | (b[i + 2] & 63); n = 3; }
      else { cp = ((c & 7) << 18) | ((b[i + 1] & 63) << 12) | ((b[i + 2] & 63) << 6) | (b[i + 3] & 63); n = 4; }
      s += String.fromCodePoint(cp);
      i += n;
    }
    return s;
  };
  globalThis.TextEncoder = class TextEncoder { get encoding() { return 'utf-8'; } encode(s) { return utf8encode(s === undefined ? '' : s); } };
  globalThis.TextDecoder = class TextDecoder { get encoding() { return 'utf-8'; } decode(b) { return b === undefined ? '' : utf8decode(b); } };
  globalThis.btoa = (str) => {
    const bytes = new Uint8Array(String(str).length);
    for (let i = 0; i < bytes.length; i++) {
      const c = String(str).charCodeAt(i);
      if (c > 255) throw new Error('btoa: Latin-1 の範囲外の文字です(TextEncoder + udjat.base64.encode を使ってください)');
      bytes[i] = c;
    }
    return b64encode(bytes);
  };
  globalThis.atob = (str) => Array.from(b64decode(String(str)), (c) => String.fromCharCode(c)).join('');
  // Web 標準風の fetch(モデルは udjat.fetch より素の fetch を書きがち)。
  // 応答は Response 風: status / ok / headers.get() / text() / json()
  function normalizeInit(init) {
    const i = init || {};
    const headers = {};
    if (i.headers && typeof i.headers === 'object')
      for (const k of Object.keys(i.headers)) headers[String(k).toLowerCase()] = String(i.headers[k]);
    const body = i.body == null ? undefined : typeof i.body === 'string' ? i.body : JSON.stringify(i.body);
    if (body !== undefined && typeof i.body !== 'string' && !headers['content-type'])
      headers['content-type'] = 'application/json';
    return { method: i.method || 'GET', headers, ...(body !== undefined ? { body } : {}) };
  }
  const toResponse = (url, r) => {
    const h = {};
    for (const k of Object.keys(r.headers || {})) h[k.toLowerCase()] = r.headers[k];
    return Object.freeze({
      url,
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      statusText: '',
      truncated: !!r.truncated,
      headers: Object.freeze({
        get: (k) => h[String(k).toLowerCase()] ?? null,
        has: (k) => String(k).toLowerCase() in h,
        entries: () => Object.entries(h),
      }),
      text: () => Promise.resolve(r.base64 ? utf8decode(b64decode(r.base64)) : r.text),
      json: () => Promise.resolve().then(() => JSON.parse(r.base64 ? utf8decode(b64decode(r.base64)) : r.text)),
      bytes: () => Promise.resolve(r.base64 ? b64decode(r.base64) : utf8encode(r.text)),
      arrayBuffer: () => Promise.resolve((r.base64 ? b64decode(r.base64) : utf8encode(r.text)).buffer),
    });
  };
  globalThis.fetch = (url, init) => udjat.fetch(String(url), init).then((r) => toResponse(String(url), r));
})();
`;

function errorText(vm: QuickJSContext, handle: QuickJSHandle): string {
  const e = vm.dump(handle) as unknown;
  if (e && typeof e === 'object') {
    const { name, message, stack } = e as { name?: string; message?: string; stack?: string };
    const head = `${name ?? 'Error'}: ${message ?? ''}`;
    return stack && !stack.startsWith(head) ? `${head}\n${stack}` : (stack ?? head);
  }
  return String(e);
}

export async function runJavaScript(code: string, opts: RunOptions): Promise<RunResult> {
  const started = Date.now();
  const deadline = started + opts.timeoutMs;
  const maxOut = opts.maxOutputChars ?? 64 * 1024;
  const maxResult = opts.maxResultChars ?? 32 * 1024;
  const QuickJS = await getModule();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(opts.memoryBytes ?? 256 * 1024 * 1024);
  runtime.setMaxStackSize(1024 * 1024);
  runtime.setInterruptHandler(() => Date.now() > deadline || (opts.signal?.aborted ?? false));
  const vm = runtime.newContext();

  let stdout = '';
  let stderr = '';
  let truncated = false;
  let alive = true;
  let pendingHost = 0;
  const handles: QuickJSHandle[] = [];
  const append = (level: string, text: string) => {
    const cur = level === 'err' ? stderr : stdout;
    if (cur.length >= maxOut) {
      truncated = true;
      return;
    }
    let next = cur + text + '\n';
    if (next.length > maxOut) {
      next = next.slice(0, maxOut);
      truncated = true;
    }
    if (level === 'err') stderr = next;
    else stdout = next;
  };

  const logFn = vm.newFunction('__host_log', (levelH, textH) => {
    append(vm.getString(levelH), vm.getString(textH));
  });
  handles.push(logFn);
  vm.setProp(vm.global, '__host_log', logFn);

  const callFn = vm.newFunction('__host_call', (nameH, argsH) => {
    const name = vm.getString(nameH);
    const raw = vm.getString(argsH);
    const deferred = vm.newPromise();
    pendingHost++;
    const settle = (payload: { ok: true; value: unknown } | { ok: false; error: string }) => {
      pendingHost--;
      if (!alive || !deferred.alive) return;
      const h = vm.newString(JSON.stringify(payload));
      deferred.resolve(h);
      h.dispose();
      // 解決結果を guest の then に届ける
      if (alive) runtime.executePendingJobs();
    };
    void dispatch(opts.host, name, raw).then(
      (value) => settle({ ok: true, value }),
      (e: unknown) => settle({ ok: false, error: (e as Error).message ?? String(e) }),
    );
    void deferred.settled.then(() => {
      try {
        if (deferred.alive) deferred.dispose();
      } catch {
        /* already disposed */
      }
    });
    return deferred.handle;
  });
  handles.push(callFn);
  vm.setProp(vm.global, '__host_call', callFn);

  const out: RunResult = { ok: false, stdout: '', stderr: '', durationMs: 0, truncated: false };
  try {
    const pre = vm.evalCode(PRELUDE, 'prelude.js');
    if (pre.error) {
      const msg = errorText(vm, pre.error);
      pre.error.dispose();
      throw new Error(`sandbox prelude failed: ${msg}`);
    }
    pre.value.dispose();

    // トップレベル await を許すため async 関数に包む。return した値が result になる
    const wrapped = `(async () => {\n${code}\n})()`;
    const res = vm.evalCode(wrapped, 'main.js');
    if (res.error) {
      out.error = errorText(vm, res.error);
      res.error.dispose();
    } else {
      const promiseH = res.value;
      handles.push(promiseH);
      const settled = vm.resolvePromise(promiseH);
      runtime.executePendingJobs();
      const timeout = new Promise<'timeout'>((resolve) => {
        const t = setInterval(() => {
          if (Date.now() > deadline || opts.signal?.aborted) {
            clearInterval(t);
            resolve('timeout');
          }
        }, 100);
        void settled.finally(() => clearInterval(t));
      });
      const r = await Promise.race([settled, timeout]);
      if (r === 'timeout') {
        out.error = opts.signal?.aborted
          ? 'aborted'
          : `timeout: ${opts.timeoutMs}ms を超えました(${pendingHost} 件のホスト呼び出しが未完了)`;
      } else if (r.error) {
        out.error = errorText(vm, r.error);
        r.error.dispose();
      } else {
        let json: string | undefined;
        try {
          const v = vm.dump(r.value) as unknown;
          json = v === undefined ? undefined : JSON.stringify(v);
        } catch (e) {
          json = JSON.stringify(String(e));
        }
        r.value.dispose();
        if (json !== undefined && json.length > maxResult) {
          out.result = json.slice(0, maxResult);
          truncated = true;
        } else if (json !== undefined) {
          out.result = JSON.parse(json) as unknown;
        }
        out.ok = true;
      }
    }
  } catch (e) {
    out.error = (e as Error).message;
  } finally {
    alive = false;
    for (const h of handles.reverse()) {
      try {
        if (h.alive) h.dispose();
      } catch {
        /* ignore */
      }
    }
    try {
      vm.dispose();
    } catch {
      /* ignore: pending handles */
    }
    try {
      runtime.dispose();
    } catch {
      /* ignore */
    }
  }
  if (out.error && /interrupted/i.test(out.error) && Date.now() > deadline) {
    out.error = `timeout: ${opts.timeoutMs}ms を超えました`;
  }
  out.stdout = stdout;
  out.stderr = stderr;
  out.truncated = truncated;
  out.durationMs = Date.now() - started;
  return out;
}

async function dispatch(host: SandboxHost, name: string, rawArgs: string): Promise<unknown> {
  const args = JSON.parse(rawArgs) as Record<string, unknown>;
  const s = (k: string): string => {
    const v = args[k];
    if (typeof v !== 'string') throw new Error(`${name}: ${k} must be a string`);
    return v;
  };
  const enc = (): 'utf8' | 'base64' => (args['encoding'] === 'base64' ? 'base64' : 'utf8');
  switch (name) {
    case 'readFile':
      return host.readFile(s('path'), enc());
    case 'writeFile':
      await host.writeFile(s('path'), s('data'), enc());
      return null;
    case 'readDir':
      return host.readDir(s('path'));
    case 'fetch': {
      const init = (args['init'] ?? {}) as {
        method?: string;
        headers?: Record<string, string>;
        body?: string;
      };
      return host.fetch(s('url'), init);
    }
    case 'listAttachments':
      return host.listAttachments();
    case 'readAttachment':
      return host.readAttachment(s('id'), enc());
    case 'sleep': {
      const ms = typeof args['ms'] === 'number' ? args['ms'] : 0;
      if (host.sleep) {
        await host.sleep(ms);
        return null;
      }
      await new Promise((r) => setTimeout(r, ms));
      return null;
    }
    case 'download': {
      if (!host.download) throw new Error('download is not available here');
      const o = (args['opts'] ?? {}) as { maxBytes?: unknown; name?: unknown; saveTo?: unknown };
      return host.download(s('url'), {
        ...(typeof o.maxBytes === 'number' ? { maxBytes: o.maxBytes } : {}),
        ...(typeof o.name === 'string' ? { name: o.name } : {}),
        ...(typeof o.saveTo === 'string' ? { saveTo: o.saveTo } : {}),
      });
    }
    case 'callTool': {
      if (!host.callTool) throw new Error('callTool is not available here');
      const a = args['args'];
      return host.callTool(
        s('name'),
        a && typeof a === 'object' ? (a as Record<string, unknown>) : {},
      );
    }
    default:
      throw new Error(`unknown host function: ${name}`);
  }
}

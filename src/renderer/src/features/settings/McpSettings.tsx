import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plug, PlugZap, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { McpServer, McpServerInput, McpServerStatus } from '@shared/schemas';
import { Button } from '@renderer/components/ui/button';
import { useConfirm } from '@renderer/components/ui/confirm';
import { Field, Input, Select, Textarea } from '@renderer/components/ui/input';
import { invoke, onEvent } from '@renderer/lib/ipc';
import { keys } from '@renderer/lib/queries';
import { cn } from '@renderer/lib/utils';

const mcpKey = ['mcp'] as const;

function useMcp() {
  return useQuery({ queryKey: mcpKey, queryFn: () => invoke('mcp:list') });
}

/** "KEY=VALUE" 行 <-> レコード */
function linesToRecord(text: string, sep: '=' | ':'): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(sep);
    if (i <= 0) continue;
    out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}
function recordToLines(rec: Record<string, string>, sep: '=' | ':'): string {
  return Object.entries(rec)
    .map(([k, v]) => `${k}${sep}${sep === ':' ? ' ' : ''}${v}`)
    .join('\n');
}

interface FormState {
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string;
  env: string;
  cwd: string;
  url: string;
  headers: string;
  enabled: boolean;
  autostart: boolean;
}

function toForm(s: McpServer | null): FormState {
  if (!s) {
    return {
      name: '',
      transport: 'stdio',
      command: '',
      args: '',
      env: '',
      cwd: '',
      url: '',
      headers: '',
      enabled: true,
      autostart: true,
    };
  }
  const c = s.config as Record<string, unknown>;
  return {
    name: s.name,
    transport: s.transport,
    command: typeof c['command'] === 'string' ? c['command'] : '',
    args: Array.isArray(c['args']) ? (c['args'] as string[]).join('\n') : '',
    env: recordToLines((c['env'] as Record<string, string>) ?? {}, '='),
    cwd: typeof c['cwd'] === 'string' ? c['cwd'] : '',
    url: typeof c['url'] === 'string' ? c['url'] : '',
    headers: recordToLines((c['headers'] as Record<string, string>) ?? {}, ':'),
    enabled: s.enabled,
    autostart: s.autostart,
  };
}

function toInput(f: FormState): McpServerInput {
  const config =
    f.transport === 'stdio'
      ? {
          command: f.command.trim(),
          args: f.args
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean),
          env: linesToRecord(f.env, '='),
          ...(f.cwd.trim() ? { cwd: f.cwd.trim() } : {}),
        }
      : { url: f.url.trim(), headers: linesToRecord(f.headers, ':') };
  return {
    name: f.name.trim(),
    transport: f.transport,
    config,
    enabled: f.enabled,
    autostart: f.autostart,
  };
}

function StatusBadge({ status }: { status: McpServerStatus | undefined }) {
  const state = status?.state ?? 'disconnected';
  const label = {
    disconnected: '未接続',
    connecting: '接続中…',
    connected: `接続済み (${status?.tools.length ?? 0} ツール)`,
    error: 'エラー',
  }[state];
  return (
    <span
      className={cn(
        'rounded border px-1.5 py-0.5 text-[10px]',
        state === 'connected' && 'border-success/40 text-success',
        state === 'error' && 'border-danger/40 text-danger',
        state === 'connecting' && 'border-accent/40 text-accent',
        state === 'disconnected' && 'border-border text-fg-muted',
      )}
      title={status?.error ?? undefined}
    >
      {label}
    </span>
  );
}

function ServerForm({
  initial,
  onSaved,
  onDeleted,
}: {
  initial: McpServer | null;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [form, setForm] = useState<FormState>(() => toForm(initial));
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));
  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: mcpKey });
    void qc.invalidateQueries({ queryKey: keys.tools });
  };
  const create = useMutation({
    mutationFn: (input: McpServerInput) => invoke('mcp:create', input),
    onSuccess: invalidate,
  });
  const update = useMutation({
    mutationFn: (v: { id: string; patch: Partial<McpServerInput> }) => invoke('mcp:update', v),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => invoke('mcp:delete', { id }),
    onSuccess: invalidate,
  });
  const err = create.error ?? update.error ?? remove.error;
  const busy = create.isPending || update.isPending;

  const save = () => {
    const input = toInput(form);
    if (initial) update.mutate({ id: initial.id, patch: input }, { onSuccess: onSaved });
    else create.mutate(input, { onSuccess: onSaved });
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3">
        <Field label="名前" hint="ツール名の接頭辞になります(英数字と _ に正規化)">
          <Input
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="例: filesystem"
          />
        </Field>
        <Field label="トランスポート">
          <Select
            value={form.transport}
            onChange={(e) => set('transport', e.target.value as 'stdio' | 'http')}
          >
            <option value="stdio">stdio (ローカルのコマンド)</option>
            <option value="http">Streamable HTTP (URL)</option>
          </Select>
        </Field>
      </div>
      {form.transport === 'stdio' ? (
        <>
          <Field
            label="コマンド"
            hint="例: npx / node / uvx / python。PATH は現在のユーザー環境から引き継ぎます"
          >
            <Input value={form.command} onChange={(e) => set('command', e.target.value)} />
          </Field>
          <Field label="引数(1 行に 1 つ)">
            <Textarea
              value={form.args}
              onChange={(e) => set('args', e.target.value)}
              className="min-h-16 font-mono text-xs"
              placeholder={'-y\n@modelcontextprotocol/server-filesystem\nC:\\data'}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="環境変数(KEY=VALUE、1 行に 1 つ)">
              <Textarea
                value={form.env}
                onChange={(e) => set('env', e.target.value)}
                className="min-h-16 font-mono text-xs"
              />
            </Field>
            <Field label="作業ディレクトリ(任意)">
              <Input value={form.cwd} onChange={(e) => set('cwd', e.target.value)} />
            </Field>
          </div>
        </>
      ) : (
        <>
          <Field label="URL">
            <Input
              value={form.url}
              onChange={(e) => set('url', e.target.value)}
              placeholder="http://192.168.0.10:3333/mcp"
            />
          </Field>
          <Field label="ヘッダ(Key: Value、1 行に 1 つ)">
            <Textarea
              value={form.headers}
              onChange={(e) => set('headers', e.target.value)}
              className="min-h-16 font-mono text-xs"
              placeholder="Authorization: Bearer xxx"
            />
          </Field>
        </>
      )}
      <div className="flex gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => set('enabled', e.target.checked)}
          />{' '}
          有効
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={form.autostart}
            onChange={(e) => set('autostart', e.target.checked)}
          />{' '}
          起動時に自動接続
        </label>
      </div>
      {err && <p className="text-xs text-danger">{String(err)}</p>}
      <div className="flex justify-between pt-2">
        {initial ? (
          <Button
            variant="danger"
            onClick={() =>
              void confirm({
                title: 'この MCP サーバーを削除しますか?',
                confirmLabel: '削除',
                danger: true,
              }).then((ok) => ok && remove.mutate(initial.id, { onSuccess: onDeleted }))
            }
          >
            <Trash2 size={14} /> 削除
          </Button>
        ) : (
          <span />
        )}
        <Button
          onClick={save}
          disabled={
            busy ||
            !form.name.trim() ||
            (form.transport === 'stdio' ? !form.command.trim() : !form.url.trim())
          }
        >
          {initial ? '保存' : '追加'}
        </Button>
      </div>
    </div>
  );
}

function ImportExport() {
  const qc = useQueryClient();
  const [json, setJson] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const importJson = useMutation({
    mutationFn: (j: string) => invoke('mcp:importJson', { json: j }),
    onSuccess: (r) => {
      setMsg(`取り込み: 追加 ${r.created} 件、更新 ${r.updated} 件`);
      setJson('');
      void qc.invalidateQueries({ queryKey: mcpKey });
    },
    onError: (e) => setMsg(String(e)),
  });
  const exportJson = async () => {
    const text = await invoke('mcp:exportJson');
    await navigator.clipboard.writeText(text);
    setMsg('mcpServers JSON をクリップボードにコピーしました');
  };
  return (
    <div className="flex flex-col gap-2">
      <Field
        label="mcpServers JSON を貼り付けて取り込む"
        hint="Claude Desktop などの設定ファイルと同じ形式。同名のサーバーは上書きされます"
      >
        <Textarea
          value={json}
          onChange={(e) => setJson(e.target.value)}
          className="min-h-24 font-mono text-xs"
          placeholder='{ "mcpServers": { "name": { "command": "npx", "args": ["..."] } } }'
        />
      </Field>
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={!json.trim() || importJson.isPending}
          onClick={() => importJson.mutate(json)}
        >
          取り込む
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void exportJson()}>
          JSON をコピー
        </Button>
        {msg && <span className="text-fg-muted text-xs">{msg}</span>}
      </div>
    </div>
  );
}

export function McpSettings() {
  const qc = useQueryClient();
  const data = useMcp();
  const [selectedId, setSelectedId] = useState<string | 'new' | null>(null);
  const connect = useMutation({
    mutationFn: (id: string) => invoke('mcp:connect', { id }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: mcpKey });
      void qc.invalidateQueries({ queryKey: keys.tools });
    },
  });
  const disconnect = useMutation({
    mutationFn: (id: string) => invoke('mcp:disconnect', { id }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: mcpKey });
      void qc.invalidateQueries({ queryKey: keys.tools });
    },
  });

  // 接続状態の変化を受け取る
  useEffect(
    () =>
      onEvent('mcp:status', () => {
        void qc.invalidateQueries({ queryKey: mcpKey });
        void qc.invalidateQueries({ queryKey: keys.tools });
      }),
    [qc],
  );

  const servers = data.data?.servers ?? [];
  const statusOf = (id: string) => data.data?.statuses.find((s) => s.id === id);
  const effectiveId: string | 'new' = selectedId ?? servers[0]?.id ?? 'new';
  const selected =
    effectiveId === 'new' ? null : (servers.find((s) => s.id === effectiveId) ?? null);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex gap-4">
        <div className="w-60 shrink-0">
          {servers.map((s) => {
            const st = statusOf(s.id);
            const connected = st?.state === 'connected' || st?.state === 'connecting';
            return (
              <div
                key={s.id}
                className={cn(
                  'hover:bg-surface-3 flex items-center gap-1 rounded-md px-2 py-1.5 text-sm',
                  effectiveId === s.id && 'bg-surface-3',
                )}
              >
                <button
                  type="button"
                  className="min-w-0 flex-1 text-left"
                  onClick={() => setSelectedId(s.id)}
                >
                  <div className="truncate">{s.name}</div>
                  <div className="mt-0.5">
                    <StatusBadge status={st} />
                  </div>
                </button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={connected ? '切断' : '接続'}
                  title={connected ? '切断' : '接続'}
                  disabled={!s.enabled || connect.isPending || disconnect.isPending}
                  onClick={() => (connected ? disconnect.mutate(s.id) : connect.mutate(s.id))}
                >
                  {st?.state === 'connecting' ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : connected ? (
                    <PlugZap size={13} />
                  ) : (
                    <Plug size={13} />
                  )}
                </Button>
              </div>
            );
          })}
          <Button
            variant="ghost"
            className="mt-1 w-full justify-start"
            onClick={() => setSelectedId('new')}
          >
            <Plus size={14} /> 追加
          </Button>
        </div>
        <div className="border-border min-w-0 flex-1 border-l pl-4">
          {selected && statusOf(selected.id)?.state === 'error' && (
            <p className="mb-2 rounded border border-danger/30 bg-danger/10 px-2 py-1 text-xs text-danger whitespace-pre-wrap">
              {statusOf(selected.id)?.error}
            </p>
          )}
          {selected && (statusOf(selected.id)?.tools.length ?? 0) > 0 && (
            <div className="text-fg-muted mb-2 text-[11px]">
              ツール:{' '}
              {statusOf(selected.id)!
                .tools.map((t) => t.name)
                .join(', ')}
            </div>
          )}
          <ServerForm
            key={selected?.id ?? 'new'}
            initial={selected}
            onSaved={() => setSelectedId(null)}
            onDeleted={() => setSelectedId('new')}
          />
        </div>
      </div>
      <section className="border-border border-t pt-4">
        <ImportExport />
      </section>
    </div>
  );
}

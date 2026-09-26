import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { invoke } from './lib/ipc';

/**
 * M0 のスモーク画面: アプリ情報の表示と settings の読み書きで
 * IPC -> main -> SQLite の往復を確認する。M1 でチャット UI に置き換える。
 */
export function App() {
  const qc = useQueryClient();
  const info = useQuery({ queryKey: ['app:info'], queryFn: () => invoke('app:info') });
  const settings = useQuery({ queryKey: ['settings:all'], queryFn: () => invoke('settings:all') });

  const [key, setKey] = useState('smoke.note');
  const [value, setValue] = useState('');

  const save = useMutation({
    mutationFn: (v: { key: string; value: string }) => invoke('settings:set', v),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['settings:all'] }),
  });

  return (
    <main className="mx-auto flex h-full max-w-3xl flex-col gap-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Udjat</h1>
        <p className="text-fg-muted text-sm">M0 足場 / IPC と SQLite の疎通確認</p>
      </header>

      <section className="bg-surface-2 border-border rounded-lg border p-4">
        <h2 className="mb-2 text-sm font-medium">アプリ情報</h2>
        {info.isPending && <p className="text-fg-muted text-sm">読み込み中...</p>}
        {info.isError && <p className="text-sm text-red-400">{String(info.error)}</p>}
        {info.data && (
          <dl className="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
            <dt className="text-fg-muted">バージョン</dt>
            <dd>{info.data.version}</dd>
            <dt className="text-fg-muted">データ配置</dt>
            <dd>
              <span className="bg-surface border-border mr-2 rounded border px-1.5 py-0.5 text-xs">
                {info.data.dataDirMode}
              </span>
              <span className="break-all">{info.data.dataDir}</span>
            </dd>
            <dt className="text-fg-muted">Electron</dt>
            <dd>{info.data.versions.electron}</dd>
            <dt className="text-fg-muted">Node</dt>
            <dd>{info.data.versions.node}</dd>
            <dt className="text-fg-muted">Chromium</dt>
            <dd>{info.data.versions.chrome}</dd>
            <dt className="text-fg-muted">SQLite</dt>
            <dd>{info.data.versions.sqlite}</dd>
          </dl>
        )}
      </section>

      <section className="bg-surface-2 border-border rounded-lg border p-4">
        <h2 className="mb-2 text-sm font-medium">settings テーブル</h2>
        <form
          className="mb-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({ key, value });
          }}
        >
          <input
            className="bg-surface border-border w-40 rounded border px-2 py-1 text-sm"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="key"
          />
          <input
            className="bg-surface border-border flex-1 rounded border px-2 py-1 text-sm"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="value"
          />
          <button
            type="submit"
            disabled={save.isPending || key.length === 0}
            className="bg-accent rounded px-3 py-1 text-sm font-medium text-black disabled:opacity-50"
          >
            保存
          </button>
        </form>
        {save.isError && <p className="text-sm text-red-400">{String(save.error)}</p>}
        <pre className="bg-surface border-border max-h-64 overflow-auto rounded border p-2 text-xs">
          {settings.data ? JSON.stringify(settings.data, null, 2) : '...'}
        </pre>
      </section>
    </main>
  );
}

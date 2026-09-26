import { useState } from 'react';
import type { ToolPolicy } from '@shared/schemas';
import { Button } from '@renderer/components/ui/button';
import { Field, Input, Select } from '@renderer/components/ui/input';
import {
  useSetting,
  useSettingMutation,
  useToolPolicyMutation,
  useTools,
} from '@renderer/lib/queries';

const POLICY_LABEL: Record<ToolPolicy, string> = {
  auto: '自動で実行',
  ask: '毎回確認',
  deny: '無効',
};

function WebSearchSettings() {
  const backend = useSetting<string>('webSearch.backend');
  const searxng = useSetting<string>('webSearch.searxngUrl');
  const brave = useSetting<string>('webSearch.braveApiKey');
  const allowHosts = useSetting<string[]>('webFetch.allowHosts');
  const save = useSettingMutation();

  const [form, setForm] = useState<{
    backend: string;
    searxng: string;
    brave: string;
    allow: string;
  } | null>(null);
  const loaded = backend.isFetched && searxng.isFetched && brave.isFetched && allowHosts.isFetched;
  const current = form ?? {
    backend: backend.data ?? 'duckduckgo',
    searxng: searxng.data ?? '',
    brave: brave.data ?? '',
    allow: (allowHosts.data ?? []).join(', '),
  };
  if (!loaded) return <p className="text-fg-muted text-xs">読み込み中…</p>;

  const set = (patch: Partial<typeof current>) => setForm({ ...current, ...patch });
  const persist = async () => {
    await save.mutateAsync({ key: 'webSearch.backend', value: current.backend });
    await save.mutateAsync({ key: 'webSearch.searxngUrl', value: current.searxng.trim() });
    await save.mutateAsync({ key: 'webSearch.braveApiKey', value: current.brave.trim() });
    await save.mutateAsync({
      key: 'webFetch.allowHosts',
      value: current.allow
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean),
    });
    setForm(null);
  };

  return (
    <div className="flex flex-col gap-3">
      <Field
        label="Web 検索バックエンド"
        hint="DuckDuckGo は非公式の HTML エンドポイントを使うため、短時間に多く検索するとレートリミットにかかります"
      >
        <Select value={current.backend} onChange={(e) => set({ backend: e.target.value })}>
          <option value="duckduckgo">DuckDuckGo (設定不要)</option>
          <option value="searxng">SearXNG (自前インスタンス)</option>
          <option value="brave">Brave Search API (キー必要)</option>
        </Select>
      </Field>
      {current.backend === 'searxng' && (
        <Field
          label="SearXNG の URL"
          hint="JSON 出力を有効にしたインスタンス。例: http://192.168.1.30:8080"
        >
          <Input value={current.searxng} onChange={(e) => set({ searxng: e.target.value })} />
        </Field>
      )}
      {current.backend === 'brave' && (
        <Field label="Brave Search API キー">
          <Input
            type="password"
            value={current.brave}
            onChange={(e) => set({ brave: e.target.value })}
            autoComplete="off"
          />
        </Field>
      )}
      <Field
        label="web_fetch で許可するプライベートホスト"
        hint="通常 LAN 内のアドレスは取得を拒否します(SSRF 対策)。必要なホストをカンマ区切りで。例: 192.168.1.5, nas.local"
      >
        <Input value={current.allow} onChange={(e) => set({ allow: e.target.value })} />
      </Field>
      <div className="flex justify-end">
        <Button onClick={() => void persist()} disabled={form === null || save.isPending}>
          保存
        </Button>
      </div>
    </div>
  );
}

function GeneralSettings() {
  const autoTitle = useSetting<boolean>('titles.auto');
  const save = useSettingMutation();
  const enabled = autoTitle.data !== false;
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={enabled}
        disabled={!autoTitle.isFetched || save.isPending}
        onChange={(e) => save.mutate({ key: 'titles.auto', value: e.target.checked })}
      />
      最初の往復が終わったら、モデルに会話タイトルを付けさせる
    </label>
  );
}

export function ToolsSettings() {
  const tools = useTools();
  const setPolicy = useToolPolicyMutation();

  return (
    <div className="flex flex-col gap-6">
      <section>
        <h3 className="mb-2 text-sm font-medium">一般</h3>
        <GeneralSettings />
      </section>
      <section>
        <h3 className="mb-2 text-sm font-medium">ツールの承認ポリシー</h3>
        <div className="flex flex-col gap-2">
          {tools.data?.map((t) => (
            <div
              key={t.name}
              className="border-border flex items-center gap-3 rounded-md border px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="font-mono text-sm">{t.name}</div>
                <div className="text-fg-muted truncate text-[11px]">{t.description}</div>
              </div>
              <Select
                className="w-36"
                value={t.policy}
                onChange={(e) =>
                  setPolicy.mutate({ name: t.name, policy: e.target.value as ToolPolicy })
                }
              >
                {(Object.keys(POLICY_LABEL) as ToolPolicy[]).map((p) => (
                  <option key={p} value={p}>
                    {POLICY_LABEL[p]}
                  </option>
                ))}
              </Select>
            </div>
          ))}
          {tools.data?.length === 0 && <p className="text-fg-muted text-xs">ツールはありません</p>}
        </div>
      </section>
      <section>
        <h3 className="mb-2 text-sm font-medium">Web 検索 / 取得</h3>
        <WebSearchSettings />
      </section>
    </div>
  );
}

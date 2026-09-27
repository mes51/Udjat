import { Plug } from 'lucide-react';
import { useState } from 'react';
import type { ToolPolicy } from '@shared/schemas';
import { Field, Input, Select } from '@renderer/components/ui/input';
import { Section, SectionTitle } from '@renderer/components/ui/section';
import {
  useSetting,
  useSettingMutation,
  useToolPolicyMutation,
  useTools,
} from '@renderer/lib/queries';
import { groupToolsByCategory, type ToolCategory } from '@renderer/lib/tools';

const POLICY_LABEL: Record<ToolPolicy, string> = {
  auto: '自動で実行',
  ask: '毎回確認',
  deny: '無効',
};

/** Web 検索 / 取得の設定。「Web」カテゴリの直下に置く。値はフォーカスを外した時に保存する */
function WebSearchSettings() {
  const backend = useSetting<string>('webSearch.backend');
  const searxng = useSetting<string>('webSearch.searxngUrl');
  const brave = useSetting<string>('webSearch.braveApiKey');
  const allowHosts = useSetting<string[]>('webFetch.allowHosts');
  const save = useSettingMutation();
  const [searxngText, setSearxngText] = useState<string | null>(null);
  const [braveText, setBraveText] = useState<string | null>(null);
  const [allowText, setAllowText] = useState<string | null>(null);
  const loaded = backend.isFetched && searxng.isFetched && brave.isFetched && allowHosts.isFetched;
  if (!loaded) return <p className="text-fg-muted text-xs">読み込み中…</p>;
  const cur = {
    backend: backend.data ?? 'duckduckgo',
    searxng: searxngText ?? searxng.data ?? '',
    brave: braveText ?? brave.data ?? '',
    allow: allowText ?? (allowHosts.data ?? []).join(', '),
  };
  const commit = (key: string, value: unknown) => save.mutate({ key, value });

  return (
    <div className="border-border bg-surface-2/60 flex flex-col gap-3 rounded-md border px-3 py-3">
      <div className="grid grid-cols-2 gap-3">
        <Field
          label="Web 検索バックエンド"
          hint="DuckDuckGo は非公式の HTML エンドポイントを使うため、短時間に多く検索するとレートリミットにかかります"
        >
          <Select value={cur.backend} onChange={(e) => commit('webSearch.backend', e.target.value)}>
            <option value="duckduckgo">DuckDuckGo (設定不要)</option>
            <option value="searxng">SearXNG (自前インスタンス)</option>
            <option value="brave">Brave Search API (キー必要)</option>
          </Select>
        </Field>
        {cur.backend === 'searxng' && (
          <Field
            label="SearXNG の URL"
            hint="JSON 出力を有効にしたインスタンス。例: http://192.168.1.30:8080"
          >
            <Input
              value={cur.searxng}
              onChange={(e) => setSearxngText(e.target.value)}
              onBlur={() => {
                if (searxngText !== null) commit('webSearch.searxngUrl', searxngText.trim());
                setSearxngText(null);
              }}
            />
          </Field>
        )}
        {cur.backend === 'brave' && (
          <Field label="Brave Search API キー">
            <Input
              type="password"
              value={cur.brave}
              autoComplete="off"
              onChange={(e) => setBraveText(e.target.value)}
              onBlur={() => {
                if (braveText !== null) commit('webSearch.braveApiKey', braveText.trim());
                setBraveText(null);
              }}
            />
          </Field>
        )}
      </div>
      <Field
        label="web_fetch で許可するプライベートホスト"
        hint="通常 LAN 内のアドレスは取得を拒否します(SSRF 対策)。必要なホストをカンマ区切りで。例: 192.168.1.5, nas.local"
      >
        <Input
          value={cur.allow}
          onChange={(e) => setAllowText(e.target.value)}
          onBlur={() => {
            if (allowText !== null)
              commit(
                'webFetch.allowHosts',
                allowText
                  .split(/[,\s]+/)
                  .map((s) => s.trim())
                  .filter(Boolean),
              );
            setAllowText(null);
          }}
        />
      </Field>
    </div>
  );
}

/** カテゴリ 1 つ分の承認ポリシー一覧 */
function CategoryPolicies({ category }: { category: ToolCategory }) {
  const setPolicy = useToolPolicyMutation();
  const isMcp = category.id.startsWith('mcp:');
  return (
    <div className="border-border divide-border divide-y rounded-md border">
      <div className="bg-surface-2/60 flex items-center gap-2 rounded-t-md px-3 py-1.5 text-xs font-medium">
        {isMcp && <Plug size={12} className="text-fg-muted" />}
        <span>{category.label}</span>
        <span className="text-fg-subtle font-normal">
          {isMcp ? 'MCP · ' : ''}
          {category.tools.length} 件
        </span>
      </div>
      {category.tools.map((t) => (
        <div key={t.name} className="flex items-start gap-3 px-3 py-2">
          <div className="min-w-0 flex-1">
            <div className="font-mono text-[13px]">{t.name}</div>
            <div className="text-fg-muted text-[11px] leading-snug">{t.description}</div>
          </div>
          <Select
            className="w-32 shrink-0"
            value={t.policy}
            aria-label={`${t.name} の承認ポリシー`}
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
    </div>
  );
}

export function ToolsSettings() {
  const tools = useTools();
  const cats = groupToolsByCategory(tools.data ?? []);

  return (
    <div className="flex flex-col gap-6">
      <Section>
        <SectionTitle description="「自動で実行」は確認なしに実行、「毎回確認」は承認カードを出す、「無効」はモデルに渡さない。カテゴリの ON/OFF は入力欄のチップ、会話ごとの個別 ON/OFF は会話の設定で">
          ツールの承認ポリシー
        </SectionTitle>
        <div className="flex flex-col gap-4">
          {cats.map((c) => (
            <div key={c.id} className="flex flex-col gap-2">
              <CategoryPolicies category={c} />
              {c.id === 'web' && <WebSearchSettings />}
            </div>
          ))}
          {cats.length === 0 && <p className="text-fg-muted text-xs">ツールはありません</p>}
        </div>
      </Section>
      {!cats.some((c) => c.id === 'web') && (
        <Section>
          <SectionTitle>Web 検索 / 取得</SectionTitle>
          <WebSearchSettings />
        </Section>
      )}
    </div>
  );
}

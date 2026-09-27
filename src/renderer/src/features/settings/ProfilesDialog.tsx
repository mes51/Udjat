import { Plug, Plus, Server, SlidersHorizontal, Trash2, Wrench } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import {
  DEFAULT_MODEL_MANAGEMENT,
  SERVER_KIND_LABELS,
  ServerKindSchema,
  type CapabilityOverrides,
  type ModelInfo,
  type ServerKind,
  type ServerProfile,
  type ServerProfileInput,
} from '@shared/schemas';
import { Button } from '@renderer/components/ui/button';
import { useConfirm } from '@renderer/components/ui/confirm';
import { Dialog } from '@renderer/components/ui/dialog';
import { Field, Input, Select } from '@renderer/components/ui/input';
import { Section, SectionTitle } from '@renderer/components/ui/section';
import { invoke } from '@renderer/lib/ipc';
import { useProfileMutations, useProfiles } from '@renderer/lib/queries';
import { cn, modelDisplayName } from '@renderer/lib/utils';
import { useUiStore } from '@renderer/state/ui-store';
import { GeneralSettings } from './GeneralSettings';
import { McpSettings } from './McpSettings';
import { ToolsSettings } from './ToolsSettings';

const DEFAULT_URLS: Record<ServerKind, string> = {
  ollama: 'http://192.168.1.10:11434',
  llamacpp: 'http://192.168.1.10:8080',
  vllm: 'http://192.168.1.10:8000',
  lmstudio: 'http://192.168.1.10:1234',
  unsloth: 'http://192.168.1.10:8888',
  'openai-compatible': 'http://192.168.1.10:8000',
};

/** モデルのロード/アンロードを Udjat から操作できる種別 */
const MANAGEABLE_KINDS: ServerKind[] = ['unsloth', 'llamacpp', 'lmstudio'];

const EMPTY: ServerProfileInput = {
  name: '',
  kind: 'ollama',
  baseUrl: DEFAULT_URLS.ollama,
  apiKey: null,
  defaultModel: null,
  defaultParams: {},
  capabilityOverrides: {},
  modelManagement: DEFAULT_MODEL_MANAGEMENT,
};

type TriState = '' | 'on' | 'off';
const OVERRIDE_KEYS: { key: keyof CapabilityOverrides; label: string }[] = [
  { key: 'image', label: '画像入力' },
  { key: 'tools', label: 'ツール呼び出し' },
  { key: 'reasoning', label: '思考 (thinking)' },
  { key: 'audio', label: '音声入力' },
];

function ProfileForm({
  initial,
  onSaved,
  onDeleted,
}: {
  initial: ServerProfile | null;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const { create, update, remove } = useProfileMutations();
  const confirmDialog = useConfirm();
  const [form, setForm] = useState<ServerProfileInput>(initial ?? EMPTY);
  const [ctx, setCtx] = useState(initial?.defaultParams.contextLength?.toString() ?? '');
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [test, setTest] = useState<{ state: 'idle' | 'running' | 'ok' | 'ng'; message: string }>({
    state: 'idle',
    message: '',
  });

  // initial が変わる時は親が key を変えて再マウントするので、ここで同期はしない

  const set = <K extends keyof ServerProfileInput>(k: K, v: ServerProfileInput[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const runTest = async () => {
    setTest({ state: 'running', message: '接続中…' });
    const r = await invoke('profiles:test', form);
    if (r.ok) {
      setModels(r.models);
      setTest({ state: 'ok', message: `接続成功。モデル ${r.models.length} 件` });
      if (!form.defaultModel && r.models[0]) set('defaultModel', r.models[0].id);
    } else {
      setTest({ state: 'ng', message: r.error ?? '失敗' });
    }
  };

  const save = () => {
    const contextLength = ctx.trim() === '' ? undefined : Number(ctx);
    const defaultParams = { ...form.defaultParams };
    if (contextLength !== undefined && Number.isFinite(contextLength))
      defaultParams.contextLength = contextLength;
    else delete defaultParams.contextLength;
    const input: ServerProfileInput = {
      ...form,
      defaultParams,
      name: form.name.trim() || form.baseUrl,
    };
    if (initial) update.mutate({ id: initial.id, patch: input }, { onSuccess: onSaved });
    else create.mutate(input, { onSuccess: onSaved });
  };

  const overrideValue = (k: keyof CapabilityOverrides): TriState => {
    const v = form.capabilityOverrides[k];
    return v === undefined ? '' : v ? 'on' : 'off';
  };
  const setOverride = (k: keyof CapabilityOverrides, v: TriState) => {
    const next = { ...form.capabilityOverrides };
    if (v === '') delete next[k];
    else (next as Record<string, unknown>)[k] = v === 'on';
    set('capabilityOverrides', next);
  };

  const busy = create.isPending || update.isPending;
  const err = create.error ?? update.error ?? remove.error;
  const mm = form.modelManagement ?? DEFAULT_MODEL_MANAGEMENT;

  return (
    <div className="flex flex-col gap-6">
      <Section className="gap-3">
        <SectionTitle>接続</SectionTitle>
        <div className="grid grid-cols-2 gap-3">
          <Field label="名前">
            <Input
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="例: 自宅サーバー"
            />
          </Field>
          <Field label="種別">
            <Select
              value={form.kind}
              onChange={(e) => {
                const kind = ServerKindSchema.parse(e.target.value);
                set('kind', kind);
                if (!initial && Object.values(DEFAULT_URLS).includes(form.baseUrl))
                  set('baseUrl', DEFAULT_URLS[kind]);
              }}
            >
              {ServerKindSchema.options.map((k) => (
                <option key={k} value={k}>
                  {SERVER_KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-[3fr_2fr] gap-3">
          <Field label="Base URL" hint="例: http://192.168.1.10:11434 (末尾の /v1 は不要)">
            <Input value={form.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} />
          </Field>
          <Field label="API キー (任意)">
            <Input
              type="password"
              value={form.apiKey ?? ''}
              onChange={(e) => set('apiKey', e.target.value === '' ? null : e.target.value)}
              autoComplete="off"
            />
          </Field>
        </div>
      </Section>

      <Section className="gap-3">
        <SectionTitle>モデル</SectionTitle>
        <div className="flex items-end gap-2">
          <Field label="既定モデル">
            <div className="flex gap-2">
              <Input
                list="model-candidates"
                value={form.defaultModel ?? ''}
                onChange={(e) => set('defaultModel', e.target.value === '' ? null : e.target.value)}
                placeholder="接続テストで取得、または手入力"
                className="w-80"
              />
              <datalist id="model-candidates">
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </datalist>
            </div>
          </Field>
          <Button
            variant="secondary"
            onClick={() => void runTest()}
            disabled={test.state === 'running'}
          >
            接続テスト
          </Button>
          {test.state !== 'idle' && (
            <span
              className={cn(
                'pb-1.5 text-xs whitespace-pre-line',
                test.state === 'ok'
                  ? 'text-success'
                  : test.state === 'ng'
                    ? 'text-danger'
                    : 'text-fg-muted',
              )}
            >
              {test.message}
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field
            label="既定のコンテキスト長 (任意)"
            hint="Ollama の num_ctx。既定 4096 は短いので明示推奨"
          >
            <Input
              type="number"
              step={1024}
              value={ctx}
              onChange={(e) => setCtx(e.target.value)}
              placeholder="例: 16384"
            />
          </Field>
        </div>
        {MANAGEABLE_KINDS.includes(form.kind) && (
          <div className="border-border bg-surface-2/60 flex flex-col gap-1.5 rounded-md border px-3 py-2.5">
            <div className="text-xs font-medium">モデルのロード / アンロード</div>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={mm.autoLoad}
                onChange={(e) => set('modelManagement', { ...mm, autoLoad: e.target.checked })}
              />
              送信直前に、選択中のモデルが未ロードなら自動でロードする
            </label>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={mm.unloadOthers}
                onChange={(e) => set('modelManagement', { ...mm, unloadOthers: e.target.checked })}
              />
              ロード前に、常駐している他のモデルをアンロードする
            </label>
            <p className="text-fg-subtle text-[11px]">
              {form.kind === 'llamacpp'
                ? 'llama.cpp は router モード(--models-dir / --models-preset で起動)の時だけ対応します。単一モデル起動では何もしません。'
                : form.kind === 'unsloth'
                  ? 'Unsloth Studio の /v1/load・/v1/unload を使います。'
                  : 'LM Studio の REST API v1(/api/v1/models/load・unload)を使います。'}
            </p>
          </div>
        )}
      </Section>

      <Section className="gap-2">
        <SectionTitle description="自動推定が外れる時だけ変更。モデル単位の上書きは会話の設定パネルで">
          capability の上書き
        </SectionTitle>
        <div className="grid grid-cols-4 gap-2">
          {OVERRIDE_KEYS.map(({ key, label }) => (
            <Field key={key} label={label}>
              <Select
                value={overrideValue(key)}
                onChange={(e) => setOverride(key, e.target.value as TriState)}
              >
                <option value="">自動</option>
                <option value="on">あり</option>
                <option value="off">なし</option>
              </Select>
            </Field>
          ))}
        </div>
      </Section>

      {err && <p className="text-danger text-xs">{String(err)}</p>}
      <div className="border-border flex justify-between border-t pt-4">
        {initial ? (
          <Button
            variant="danger"
            onClick={() =>
              void confirmDialog({
                title: 'このプロファイルを削除しますか?',
                description: 'この接続先を使っている会話は、接続先未設定になります。',
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
        <Button onClick={save} disabled={busy || form.baseUrl.trim() === ''}>
          {initial ? '保存' : '追加'}
        </Button>
      </div>
    </div>
  );
}

/** サーバータブ: 左に一覧、右にフォーム */
function ServersTab() {
  const profiles = useProfiles();
  const [selectedId, setSelectedId] = useState<string | 'new' | null>(null);
  // 未選択なら先頭のプロファイル、無ければ新規フォーム
  const effectiveId: string | 'new' = selectedId ?? profiles.data?.[0]?.id ?? 'new';
  const selected =
    effectiveId === 'new' ? null : (profiles.data?.find((p) => p.id === effectiveId) ?? null);
  return (
    <div className="flex gap-5">
      <div className="w-52 shrink-0">
        <div className="flex flex-col gap-0.5">
          {profiles.data?.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setSelectedId(p.id)}
              className={cn(
                'hover:bg-surface-3 text-fg-muted block w-full rounded-md px-2 py-1.5 text-left text-sm transition-colors',
                effectiveId === p.id && 'bg-accent-soft text-fg',
              )}
            >
              <div className="truncate">{p.name}</div>
              <div className="text-fg-subtle truncate text-[11px]">
                {SERVER_KIND_LABELS[p.kind]}
                {p.defaultModel ? ` · ${modelDisplayName(p.defaultModel)}` : ''}
              </div>
            </button>
          ))}
        </div>
        <Button
          variant="ghost"
          className="mt-1 w-full justify-start"
          onClick={() => setSelectedId('new')}
        >
          <Plus size={14} /> 追加
        </Button>
      </div>
      <div className="border-border min-w-0 flex-1 border-l pl-5">
        <ProfileForm
          key={selected?.id ?? 'new'}
          initial={selected}
          onSaved={() => setSelectedId(null)}
          onDeleted={() => setSelectedId('new')}
        />
      </div>
    </div>
  );
}

type Tab = 'servers' | 'tools' | 'mcp' | 'general';
const TABS: { id: Tab; label: string; description: string; icon: ReactNode }[] = [
  {
    id: 'servers',
    label: 'サーバー',
    description: '接続先の LLM サーバー',
    icon: <Server size={15} />,
  },
  {
    id: 'tools',
    label: 'ツール',
    description: '承認ポリシーと Web 検索',
    icon: <Wrench size={15} />,
  },
  { id: 'mcp', label: 'MCP', description: 'MCP サーバーの登録と接続', icon: <Plug size={15} /> },
  {
    id: 'general',
    label: '一般',
    description: '表示、ffmpeg、動画、バックアップ',
    icon: <SlidersHorizontal size={15} />,
  },
];

export function ProfilesDialog() {
  const open = useUiStore((s) => s.profilesDialogOpen);
  const setOpen = useUiStore((s) => s.setProfilesDialogOpen);
  const [tab, setTab] = useState<Tab>('servers');
  const current = TABS.find((t) => t.id === tab) ?? TABS[0]!;

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="設定"
      aside={
        <div className="flex flex-col gap-0.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                'text-fg-muted hover:bg-surface-3 hover:text-fg flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors',
                tab === t.id && 'bg-accent-soft text-fg',
              )}
            >
              {t.icon}
              {t.label}
            </button>
          ))}
        </div>
      }
    >
      <div className="mb-4">
        <h3 className="text-base font-semibold">{current.label}</h3>
        <p className="text-fg-muted text-xs">{current.description}</p>
      </div>
      {/* サーバータブは選択状態を保つため、非表示でもマウントしたままにする */}
      <div className={cn(tab !== 'servers' && 'hidden')}>
        <ServersTab />
      </div>
      {tab === 'tools' && <ToolsSettings />}
      {tab === 'mcp' && <McpSettings />}
      {tab === 'general' && <GeneralSettings />}
    </Dialog>
  );
}

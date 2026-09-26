import { Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import {
  SERVER_KIND_LABELS,
  ServerKindSchema,
  type CapabilityOverrides,
  type ModelInfo,
  type ServerKind,
  type ServerProfile,
  type ServerProfileInput,
} from '@shared/schemas';
import type { AppInfo } from '@shared/ipc-schema';
import { Button } from '@renderer/components/ui/button';
import { useConfirm } from '@renderer/components/ui/confirm';
import { Dialog } from '@renderer/components/ui/dialog';
import { Field, Input, Select } from '@renderer/components/ui/input';
import { invoke } from '@renderer/lib/ipc';
import { useProfileMutations, useProfiles } from '@renderer/lib/queries';
import { cn } from '@renderer/lib/utils';
import { useUiStore } from '@renderer/state/ui-store';
import { ToolsSettings } from './ToolsSettings';

const DEFAULT_URLS: Record<ServerKind, string> = {
  ollama: 'http://192.168.1.10:11434',
  llamacpp: 'http://192.168.1.10:8080',
  vllm: 'http://192.168.1.10:8000',
  lmstudio: 'http://192.168.1.10:1234',
  'openai-compatible': 'http://192.168.1.10:8000',
};

const EMPTY: ServerProfileInput = {
  name: '',
  kind: 'ollama',
  baseUrl: DEFAULT_URLS.ollama,
  apiKey: null,
  defaultModel: null,
  defaultParams: {},
  capabilityOverrides: {},
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

  return (
    <div className="flex flex-col gap-3">
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
      <Field label="Base URL" hint="例: http://192.168.1.10:11434 (末尾の /v1 は不要)">
        <Input value={form.baseUrl} onChange={(e) => set('baseUrl', e.target.value)} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="API キー (任意)">
          <Input
            type="password"
            value={form.apiKey ?? ''}
            onChange={(e) => set('apiKey', e.target.value === '' ? null : e.target.value)}
            autoComplete="off"
          />
        </Field>
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
                ? 'text-emerald-400'
                : test.state === 'ng'
                  ? 'text-red-400'
                  : 'text-fg-muted',
            )}
          >
            {test.message}
          </span>
        )}
      </div>
      <div>
        <div className="text-fg-muted mb-1 text-xs font-medium">
          capability の上書き(自動推定が外れる時だけ変更)
        </div>
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
      </div>
      {err && <p className="text-xs text-red-400">{String(err)}</p>}
      <div className="flex justify-between pt-2">
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

export function ProfilesDialog() {
  const open = useUiStore((s) => s.profilesDialogOpen);
  const setOpen = useUiStore((s) => s.setProfilesDialogOpen);
  const profiles = useProfiles();
  const [selectedId, setSelectedId] = useState<string | 'new' | null>(null);
  const [info, setInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    if (open) void invoke('app:info').then(setInfo);
  }, [open]);

  const [tab, setTab] = useState<'servers' | 'tools'>('servers');

  // 未選択なら先頭のプロファイル、無ければ新規フォーム
  const effectiveId: string | 'new' = selectedId ?? profiles.data?.[0]?.id ?? 'new';
  const selected =
    effectiveId === 'new' ? null : (profiles.data?.find((p) => p.id === effectiveId) ?? null);

  return (
    <Dialog
      open={open}
      onOpenChange={setOpen}
      title="設定"
      description={
        tab === 'servers'
          ? '接続先の LLM サーバーを登録します'
          : 'ツールの承認ポリシーと Web 検索の設定'
      }
    >
      <div className="border-border mb-4 flex gap-1 border-b">
        {(
          [
            ['servers', 'サーバー'],
            ['tools', 'ツール'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={cn(
              'text-fg-muted hover:text-fg -mb-px border-b-2 border-transparent px-3 py-1.5 text-sm',
              tab === id && 'border-accent text-fg',
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'tools' && <ToolsSettings />}
      <div className={cn('flex gap-4', tab !== 'servers' && 'hidden')}>
        <div className="w-52 shrink-0">
          {profiles.data?.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setSelectedId(p.id)}
              className={cn(
                'hover:bg-surface-3 block w-full rounded-md px-2 py-1.5 text-left text-sm',
                effectiveId === p.id && 'bg-surface-3',
              )}
            >
              <div className="truncate">{p.name}</div>
              <div className="text-fg-muted truncate text-[11px]">{SERVER_KIND_LABELS[p.kind]}</div>
            </button>
          ))}
          <Button
            variant="ghost"
            className="mt-1 w-full justify-start"
            onClick={() => setSelectedId('new')}
          >
            <Plus size={14} /> 追加
          </Button>
        </div>
        <div className="border-border min-w-0 flex-1 border-l pl-4">
          <ProfileForm
            key={selected?.id ?? 'new'}
            initial={selected}
            onSaved={() => setSelectedId(null)}
            onDeleted={() => setSelectedId('new')}
          />
        </div>
      </div>
      {info && (
        <div className="text-fg-muted/70 border-border mt-4 border-t pt-2 text-[11px]">
          Udjat {info.version} · データ: {info.dataDirMode} ({info.dataDir}) · Electron{' '}
          {info.versions.electron} · SQLite {info.versions.sqlite}
        </div>
      )}
    </Dialog>
  );
}

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useState } from 'react';
import type { CapabilityOverrides, ChatParams, Conversation } from '@shared/schemas';
import { Button } from '@renderer/components/ui/button';
import { Field, Input, Label, Select, Textarea } from '@renderer/components/ui/input';
import { Range } from '@renderer/components/ui/range';
import { invoke } from '@renderer/lib/ipc';
import {
  keys,
  useCapabilities,
  useConversationMutations,
  useProfiles,
  useTools,
} from '@renderer/lib/queries';
import { groupToolsByCategory } from '@renderer/lib/tools';
import { cn, modelDisplayName } from '@renderer/lib/utils';
import { useToolCategoryToggle } from './ToolCategoryBar';

type NumKey =
  | 'temperature'
  | 'topP'
  | 'topK'
  | 'minP'
  | 'maxTokens'
  | 'contextLength'
  | 'seed'
  | 'repeatPenalty';

interface NumField {
  key: NumKey;
  label: string;
  step: number;
  hint?: string;
  /** スライダーで扱う範囲。無ければテキスト入力だけ */
  slider?: { min: number; max: number; default: number };
}

/** スライダー付き(範囲が決まっているもの)。default は未設定時のつまみの位置(llama.cpp の既定に合わせる) */
const SLIDER_FIELDS: NumField[] = [
  {
    key: 'temperature',
    label: 'temperature',
    step: 0.05,
    slider: { min: 0, max: 2, default: 0.8 },
  },
  { key: 'topP', label: 'top_p', step: 0.01, slider: { min: 0, max: 1, default: 0.95 } },
  { key: 'topK', label: 'top_k', step: 1, slider: { min: 0, max: 100, default: 40 } },
  { key: 'minP', label: 'min_p', step: 0.01, slider: { min: 0, max: 0.5, default: 0.05 } },
  {
    key: 'repeatPenalty',
    label: 'repeat_penalty',
    step: 0.05,
    slider: { min: 0.5, max: 2, default: 1 },
  },
];

/** 範囲がモデル次第のもの。テキスト入力だけ */
const TEXT_FIELDS: NumField[] = [
  { key: 'maxTokens', label: '最大出力トークン', step: 256 },
  {
    key: 'contextLength',
    label: 'コンテキスト長',
    step: 1024,
    hint: 'Ollama の num_ctx。他サーバーは起動時設定に従う',
  },
  { key: 'seed', label: 'seed', step: 1 },
];

const NUM_FIELDS: NumField[] = [...SLIDER_FIELDS, ...TEXT_FIELDS];

function numToStr(v: number | undefined): string {
  return v === undefined ? '' : String(v);
}

/** スライダーと数値入力を並べた 1 項目。空文字 = 既定(サーバーに任せる) */
function ParamSlider({
  field,
  value,
  onChange,
}: {
  field: NumField & { slider: NonNullable<NumField['slider']> };
  value: string;
  onChange: (v: string) => void;
}) {
  const isDefault = value.trim() === '';
  const n = Number(value);
  const pos = isDefault || !Number.isFinite(n) ? field.slider.default : n;
  return (
    <div>
      <div className="mb-0.5 flex items-center justify-between gap-2">
        <Label className="mb-0">{field.label}</Label>
        <div className="flex items-center gap-1">
          <Input
            type="number"
            step={field.step}
            min={field.slider.min}
            max={field.slider.max}
            value={value}
            placeholder="既定"
            aria-label={field.label}
            onChange={(e) => onChange(e.target.value)}
            className="h-7 w-20 px-2 text-right text-xs tabular-nums"
          />
          <button
            type="button"
            aria-label={`${field.label} を既定に戻す`}
            title="既定に戻す"
            disabled={isDefault}
            onClick={() => onChange('')}
            className="text-fg-subtle hover:text-fg disabled:opacity-0"
          >
            <X size={12} />
          </button>
        </div>
      </div>
      <Range
        min={field.slider.min}
        max={field.slider.max}
        step={field.step}
        value={pos}
        aria-label={`${field.label} スライダー`}
        className={cn(isDefault && 'is-default')}
        onChange={(e) => onChange(e.target.value)}
      />
      <div className="text-fg-subtle -mt-1 flex justify-between text-[10px] tabular-nums">
        <span>{field.slider.min}</span>
        <span>{isDefault ? `既定 (目安 ${field.slider.default})` : ''}</span>
        <span>{field.slider.max}</span>
      </div>
    </div>
  );
}

/** ドロワー内の見出し */
function SectionTitle({
  children,
  action,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="mb-2 flex items-center justify-between">
      <h4 className="text-fg-muted text-xs font-medium tracking-wide">{children}</h4>
      {action}
    </div>
  );
}

export function ConversationSettings({ conversation }: { conversation: Conversation }) {
  const { update } = useConversationMutations();
  const caps = useCapabilities(conversation.serverProfileId, conversation.model);
  const [systemPrompt, setSystemPrompt] = useState(conversation.systemPrompt ?? '');
  const [params, setParams] = useState<Record<NumKey, string>>(() =>
    toStrings(conversation.params),
  );
  const [think, setThink] = useState<'' | 'on' | 'off'>(
    conversation.params.think === undefined ? '' : conversation.params.think ? 'on' : 'off',
  );
  const [dirty, setDirty] = useState(false);

  // 会話が切り替わった / 保存後に props が更新された時にフォームを同期する(render 中の state 調整パターン)
  const [synced, setSynced] = useState(conversation);
  if (synced !== conversation) {
    setSynced(conversation);
    if (synced.id !== conversation.id || !dirty) {
      setSystemPrompt(conversation.systemPrompt ?? '');
      setParams(toStrings(conversation.params));
      setThink(
        conversation.params.think === undefined ? '' : conversation.params.think ? 'on' : 'off',
      );
      setDirty(false);
    }
  }

  const save = () => {
    const next: ChatParams = {};
    for (const f of NUM_FIELDS) {
      const raw = params[f.key].trim();
      if (raw === '') continue;
      const n = Number(raw);
      if (!Number.isFinite(n)) continue;
      next[f.key] = n;
    }
    if (think !== '') next.think = think === 'on';
    update.mutate({
      id: conversation.id,
      patch: { systemPrompt: systemPrompt.trim() === '' ? null : systemPrompt, params: next },
    });
    setDirty(false);
  };

  return (
    <div className="border-border bg-surface-2 flex w-[22rem] shrink-0 flex-col gap-5 overflow-y-auto border-l p-4 text-sm">
      <h3 className="font-medium">会話の設定</h3>
      <section>
        <SectionTitle>システムプロンプト</SectionTitle>
        <Textarea
          value={systemPrompt}
          onChange={(e) => {
            setSystemPrompt(e.target.value);
            setDirty(true);
          }}
          className="min-h-28"
          placeholder="空ならシステムプロンプトなし"
          aria-label="システムプロンプト"
        />
      </section>
      <section>
        <SectionTitle>生成パラメータ</SectionTitle>
        <div className="flex flex-col gap-3">
          {SLIDER_FIELDS.map((f) => (
            <ParamSlider
              key={f.key}
              field={f as NumField & { slider: NonNullable<NumField['slider']> }}
              value={params[f.key]}
              onChange={(v) => {
                setParams((p) => ({ ...p, [f.key]: v }));
                setDirty(true);
              }}
            />
          ))}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {TEXT_FIELDS.map((f) => (
            <Field key={f.key} label={f.label} {...(f.hint ? { hint: f.hint } : {})}>
              <Input
                type="number"
                step={f.step}
                value={params[f.key]}
                placeholder="既定"
                className="tabular-nums"
                onChange={(e) => {
                  setParams((p) => ({ ...p, [f.key]: e.target.value }));
                  setDirty(true);
                }}
              />
            </Field>
          ))}
          <Field
            label="思考 (thinking)"
            {...(caps.data?.reasoning === false ? { hint: 'このモデルは思考非対応と推定' } : {})}
          >
            <Select
              value={think}
              onChange={(e) => {
                setThink(e.target.value as '' | 'on' | 'off');
                setDirty(true);
              }}
            >
              <option value="">サーバー既定</option>
              <option value="on">有効</option>
              <option value="off">無効</option>
            </Select>
          </Field>
        </div>
        <div className="mt-3 flex items-center justify-end gap-2">
          {dirty && <span className="text-fg-subtle text-[11px]">未保存の変更があります</span>}
          <Button onClick={save} disabled={!dirty || update.isPending}>
            保存
          </Button>
        </div>
        {update.isError && <p className="text-danger mt-1 text-xs">{String(update.error)}</p>}
      </section>
      {conversation.serverProfileId && conversation.model && (
        <ModelCapabilities profileId={conversation.serverProfileId} model={conversation.model} />
      )}
      <ConversationTools conversation={conversation} />
    </div>
  );
}

type Tri = '' | 'on' | 'off';

/** 現在の状態(推定 + 上書きの解決結果)を点と短い語で */
function Status({ on, label }: { on: boolean | undefined; label?: string | undefined }) {
  return (
    <span className="flex items-center gap-1.5 text-xs">
      <span
        className={cn(
          'inline-block h-2 w-2 rounded-full',
          on === undefined ? 'bg-fg-subtle/40' : on ? 'bg-success' : 'bg-fg-subtle',
        )}
      />
      <span className={cn(on ? 'text-fg' : 'text-fg-muted')}>
        {label ?? (on === undefined ? '…' : on ? 'あり' : 'なし')}
      </span>
    </span>
  );
}

const CAP_FIELDS: { key: 'image' | 'tools' | 'reasoning' | 'audio'; label: string }[] = [
  { key: 'image', label: '画像入力' },
  { key: 'tools', label: 'ツール呼び出し' },
  { key: 'reasoning', label: '思考 (thinking)' },
  { key: 'audio', label: '音声入力' },
];

/**
 * このモデルの capability。自動推定の結果を表示し、モデル単位で上書きできる
 * (プロファイル全体の上書きより優先。切り替えは即保存)。
 */
function ModelCapabilities({ profileId, model }: { profileId: string; model: string }) {
  const qc = useQueryClient();
  const caps = useCapabilities(profileId, model);
  const profiles = useProfiles();
  const profile = profiles.data?.find((p) => p.id === profileId);
  const overrides: CapabilityOverrides = profile?.modelCapabilityOverrides[model] ?? {};
  const save = useMutation({
    mutationFn: (next: CapabilityOverrides) =>
      invoke('models:setCapabilities', { profileId, model, overrides: next }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.profiles });
      void qc.invalidateQueries({ queryKey: keys.capabilities(profileId, model) });
    },
  });

  const tri = (k: (typeof CAP_FIELDS)[number]['key']): Tri => {
    const v = overrides[k];
    return v === undefined ? '' : v ? 'on' : 'off';
  };
  const setTri = (k: (typeof CAP_FIELDS)[number]['key'], v: Tri) => {
    const next = { ...overrides };
    if (v === '') delete next[k];
    else next[k] = v === 'on';
    save.mutate(next);
  };
  const setVideo = (v: '' | 'native' | 'none') => {
    const next = { ...overrides };
    if (v === '') delete next.video;
    else next.video = v;
    save.mutate(next);
  };
  const hasOverride = Object.keys(overrides).length > 0;
  const c = caps.data;
  const rows: { key: string; label: string; status: React.ReactNode; control: React.ReactNode }[] =
    [
      ...CAP_FIELDS.map(({ key, label }) => ({
        key,
        label,
        status: <Status on={c?.[key]} />,
        control: (
          <Select
            value={tri(key)}
            aria-label={`${label} の上書き`}
            className={cn('h-7 text-xs', tri(key) !== '' && 'border-accent/60')}
            onChange={(e) => setTri(key, e.target.value as Tri)}
          >
            <option value="">自動</option>
            <option value="on">あり</option>
            <option value="off">なし</option>
          </Select>
        ),
      })),
      {
        key: 'video',
        label: '動画入力',
        status: (
          <Status
            on={c ? c.video === 'native' : undefined}
            label={c ? (c.video === 'native' ? 'ネイティブ' : 'フレーム分解') : undefined}
          />
        ),
        control: (
          <Select
            value={overrides.video ?? ''}
            aria-label="動画入力の上書き"
            className={cn('h-7 text-xs', overrides.video !== undefined && 'border-accent/60')}
            onChange={(e) => setVideo(e.target.value as '' | 'native' | 'none')}
          >
            <option value="">自動</option>
            <option value="native">ネイティブ</option>
            <option value="none">フレーム分解</option>
          </Select>
        ),
      },
    ];

  return (
    <section>
      <SectionTitle
        action={
          hasOverride && (
            <button
              type="button"
              className="text-accent text-[11px] hover:underline"
              onClick={() => save.mutate({})}
            >
              自動推定に戻す
            </button>
          )
        }
      >
        このモデルの capability
      </SectionTitle>
      <p className="text-fg-muted mb-2 truncate font-mono text-[11px]" title={model}>
        {modelDisplayName(model)}
      </p>
      <div className="border-border divide-border divide-y rounded-md border">
        <div className="text-fg-subtle grid grid-cols-[1fr_5.5rem_6.5rem] items-center gap-2 px-2.5 py-1 text-[10px]">
          <span />
          <span>現在</span>
          <span>上書き</span>
        </div>
        {rows.map((r) => (
          <div
            key={r.key}
            className="grid grid-cols-[1fr_5.5rem_6.5rem] items-center gap-2 px-2.5 py-1.5"
          >
            <span className="text-xs">{r.label}</span>
            {r.status}
            {r.control}
          </div>
        ))}
      </div>
      <p className="text-fg-subtle mt-1 text-[11px]">
        「現在」は推定と上書きを合わせた結果。ネイティブ動画は llama.cpp / vLLM のみ
      </p>
      {save.isError && <p className="text-danger mt-1 text-xs">{String(save.error)}</p>}
    </section>
  );
}

/** この会話で使うツール。カテゴリ単位は入力欄のチップと共通、個別ツールはここだけ。切り替えは即保存 */
function ConversationTools({ conversation }: { conversation: Conversation }) {
  const tools = useTools();
  const caps = useCapabilities(conversation.serverProfileId, conversation.model);
  const { update } = useConversationMutations();
  const toggleCategory = useToolCategoryToggle(conversation);
  const cats = groupToolsByCategory(tools.data ?? []);
  const { disabledCategories, disabledTools } = conversation;

  const toggleTool = (name: string) => {
    const next = disabledTools.includes(name)
      ? disabledTools.filter((n) => n !== name)
      : [...disabledTools, name];
    update.mutate({ id: conversation.id, patch: { disabledTools: next } });
  };
  const anyOff = disabledCategories.length > 0 || disabledTools.length > 0;

  return (
    <section>
      <SectionTitle
        action={
          anyOff && (
            <button
              type="button"
              className="text-accent text-[11px]"
              onClick={() =>
                update.mutate({
                  id: conversation.id,
                  patch: { disabledCategories: [], disabledTools: [] },
                })
              }
            >
              すべて有効にする
            </button>
          )
        }
      >
        この会話で使うツール
      </SectionTitle>
      {caps.data && !caps.data.tools && (
        <p className="text-fg-muted mb-1 text-[11px]">
          このモデルはツール呼び出し非対応と推定されています
        </p>
      )}
      {cats.length === 0 && <p className="text-fg-muted text-[11px]">ツールはありません</p>}
      <div className="flex flex-col gap-2">
        {cats.map((c) => {
          const catOn = !disabledCategories.includes(c.id);
          return (
            <div key={c.id}>
              <label className="flex items-center gap-2 text-xs font-medium">
                <input type="checkbox" checked={catOn} onChange={() => toggleCategory(c.id)} />
                <span>{c.label}</span>
                <span className="text-fg-muted font-normal">
                  {c.id.startsWith('mcp:') ? 'MCP' : ''} {c.tools.length} 件
                </span>
              </label>
              <div className="mt-0.5 ml-5 flex flex-col gap-0.5">
                {c.tools.map((t) => (
                  <label
                    key={t.name}
                    className={cn('flex items-center gap-2 text-xs', !catOn && 'opacity-50')}
                  >
                    <input
                      type="checkbox"
                      checked={!disabledTools.includes(t.name)}
                      disabled={t.policy === 'deny' || !catOn}
                      onChange={() => toggleTool(t.name)}
                    />
                    <span className="font-mono" title={t.description}>
                      {t.name}
                    </span>
                    {t.policy === 'deny' && <span className="text-fg-muted">(設定で無効)</span>}
                    {t.policy === 'ask' && <span className="text-fg-muted">(毎回確認)</span>}
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function toStrings(p: ChatParams): Record<NumKey, string> {
  const out = {} as Record<NumKey, string>;
  for (const f of NUM_FIELDS) out[f.key] = numToStr(p[f.key]);
  return out;
}

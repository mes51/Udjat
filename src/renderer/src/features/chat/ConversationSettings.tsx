import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { CapabilityOverrides, ChatParams, Conversation } from '@shared/schemas';
import { Button } from '@renderer/components/ui/button';
import { Field, Input, Select, Textarea } from '@renderer/components/ui/input';
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

const NUM_FIELDS: { key: NumKey; label: string; step: number; hint?: string }[] = [
  { key: 'temperature', label: 'temperature', step: 0.05 },
  { key: 'topP', label: 'top_p', step: 0.05 },
  { key: 'topK', label: 'top_k', step: 1 },
  { key: 'minP', label: 'min_p', step: 0.01 },
  { key: 'maxTokens', label: '最大出力トークン', step: 1 },
  {
    key: 'contextLength',
    label: 'コンテキスト長',
    step: 1024,
    hint: 'Ollama の num_ctx。他サーバーは起動時設定に従う',
  },
  { key: 'seed', label: 'seed', step: 1 },
  { key: 'repeatPenalty', label: 'repeat_penalty', step: 0.05 },
];

function numToStr(v: number | undefined): string {
  return v === undefined ? '' : String(v);
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
    <div className="border-border bg-surface-2 flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-l p-4 text-sm">
      <h3 className="font-medium">会話の設定</h3>
      <Field label="システムプロンプト">
        <Textarea
          value={systemPrompt}
          onChange={(e) => {
            setSystemPrompt(e.target.value);
            setDirty(true);
          }}
          className="min-h-32"
          placeholder="空ならシステムプロンプトなし"
        />
      </Field>
      <div className="grid grid-cols-2 gap-2">
        {NUM_FIELDS.map((f) => (
          <Field key={f.key} label={f.label} {...(f.hint ? { hint: f.hint } : {})}>
            <Input
              type="number"
              step={f.step}
              value={params[f.key]}
              placeholder="既定"
              onChange={(e) => {
                setParams((p) => ({ ...p, [f.key]: e.target.value }));
                setDirty(true);
              }}
            />
          </Field>
        ))}
      </div>
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
      <div className="flex justify-end gap-2">
        <Button onClick={save} disabled={!dirty || update.isPending}>
          保存
        </Button>
      </div>
      {update.isError && <p className="text-xs text-danger">{String(update.error)}</p>}
      {conversation.serverProfileId && conversation.model && (
        <ModelCapabilities profileId={conversation.serverProfileId} model={conversation.model} />
      )}
      <ConversationTools conversation={conversation} />
    </div>
  );
}

type Tri = '' | 'on' | 'off';
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

  return (
    <div className="border-border mt-2 border-t pt-3">
      <div className="mb-1 flex items-center justify-between">
        <h4 className="text-xs font-medium">このモデルの capability</h4>
        {hasOverride && (
          <button type="button" className="text-accent text-[11px]" onClick={() => save.mutate({})}>
            自動推定に戻す
          </button>
        )}
      </div>
      <p className="text-fg-muted mb-2 truncate text-[11px]" title={model}>
        {modelDisplayName(model)}
        {caps.data && (
          <>
            {' '}
            · 現在: 画像 {caps.data.image ? '○' : '×'} / ツール {caps.data.tools ? '○' : '×'} / 思考{' '}
            {caps.data.reasoning ? '○' : '×'} / 音声 {caps.data.audio ? '○' : '×'} / 動画{' '}
            {caps.data.video === 'native' ? 'ネイティブ' : 'フレーム分解'}
          </>
        )}
      </p>
      <div className="grid grid-cols-2 gap-2">
        {CAP_FIELDS.map(({ key, label }) => (
          <Field key={key} label={label}>
            <Select value={tri(key)} onChange={(e) => setTri(key, e.target.value as Tri)}>
              <option value="">自動</option>
              <option value="on">あり</option>
              <option value="off">なし</option>
            </Select>
          </Field>
        ))}
        <Field label="動画入力" hint="ネイティブ = 動画ファイルをそのまま送れる (llama.cpp / vLLM)">
          <Select
            value={overrides.video ?? ''}
            onChange={(e) => setVideo(e.target.value as '' | 'native' | 'none')}
          >
            <option value="">自動</option>
            <option value="native">ネイティブ</option>
            <option value="none">フレーム分解のみ</option>
          </Select>
        </Field>
      </div>
      {save.isError && <p className="mt-1 text-xs text-danger">{String(save.error)}</p>}
    </div>
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
    <div className="border-border mt-2 border-t pt-3">
      <div className="mb-1 flex items-center justify-between">
        <h4 className="text-xs font-medium">この会話で使うツール</h4>
        {anyOff && (
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
        )}
      </div>
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
    </div>
  );
}

function toStrings(p: ChatParams): Record<NumKey, string> {
  const out = {} as Record<NumKey, string>;
  for (const f of NUM_FIELDS) out[f.key] = numToStr(p[f.key]);
  return out;
}

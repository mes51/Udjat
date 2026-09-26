import { useState } from 'react';
import type { ChatParams, Conversation } from '@shared/schemas';
import { Button } from '@renderer/components/ui/button';
import { Field, Input, Select, Textarea } from '@renderer/components/ui/input';
import { useCapabilities, useConversationMutations, useTools } from '@renderer/lib/queries';

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
      {caps.data && (
        <div className="text-fg-muted text-[11px]">
          推定 capability: 画像 {caps.data.image ? '○' : '×'} / 音声 {caps.data.audio ? '○' : '×'} /
          動画 {caps.data.video === 'native' ? 'ネイティブ' : 'フレーム分解'} / ツール{' '}
          {caps.data.tools ? '○' : '×'} / 思考 {caps.data.reasoning ? '○' : '×'}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={save} disabled={!dirty || update.isPending}>
          保存
        </Button>
      </div>
      {update.isError && <p className="text-xs text-red-400">{String(update.error)}</p>}
      <ConversationTools conversation={conversation} />
    </div>
  );
}

/** この会話で使うツールの選択(null = 全部)。切り替えは即保存する */
function ConversationTools({ conversation }: { conversation: Conversation }) {
  const tools = useTools();
  const caps = useCapabilities(conversation.serverProfileId, conversation.model);
  const { update } = useConversationMutations();
  const all = tools.data ?? [];
  const enabled = conversation.enabledTools;
  const isOn = (name: string) => enabled === null || enabled.includes(name);

  const toggle = (name: string) => {
    const current = enabled ?? all.map((t) => t.name);
    const next = current.includes(name) ? current.filter((n) => n !== name) : [...current, name];
    const allOn = all.every((t) => next.includes(t.name));
    update.mutate({ id: conversation.id, patch: { enabledTools: allOn ? null : next } });
  };

  return (
    <div className="border-border mt-2 border-t pt-3">
      <div className="mb-1 flex items-center justify-between">
        <h4 className="text-xs font-medium">この会話で使うツール</h4>
        {enabled !== null && (
          <button
            type="button"
            className="text-accent text-[11px]"
            onClick={() => update.mutate({ id: conversation.id, patch: { enabledTools: null } })}
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
      <div className="flex flex-col gap-1">
        {all.map((t) => (
          <label key={t.name} className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={isOn(t.name)}
              disabled={t.policy === 'deny'}
              onChange={() => toggle(t.name)}
            />
            <span className="font-mono">{t.name}</span>
            {t.policy === 'deny' && <span className="text-fg-muted">(設定で無効)</span>}
            {t.policy === 'ask' && <span className="text-fg-muted">(毎回確認)</span>}
          </label>
        ))}
      </div>
    </div>
  );
}

function toStrings(p: ChatParams): Record<NumKey, string> {
  const out = {} as Record<NumKey, string>;
  for (const f of NUM_FIELDS) out[f.key] = numToStr(p[f.key]);
  return out;
}

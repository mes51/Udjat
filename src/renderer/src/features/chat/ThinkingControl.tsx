import { Brain } from 'lucide-react';
import type { ChatParams, Conversation } from '@shared/schemas';
import { Select } from '@renderer/components/ui/input';
import { useCapabilities, useConversationMutations } from '@renderer/lib/queries';
import { cn } from '@renderer/lib/utils';

/** セレクトの値: '' = サーバー既定, 'on' / 'off', 'level:<name>' = 有効 + レベル */
export function thinkValue(p: ChatParams): string {
  if (p.think === false) return 'off';
  if (p.reasoningEffort) return `level:${p.reasoningEffort}`;
  return p.think === true ? 'on' : '';
}

/** モデルが対応するレベルに、保存済みで一覧に無い値があればそれも足す */
export function thinkLevelOptions(levels: string[], current: string): string[] {
  const out = [...levels];
  if (current.startsWith('level:')) {
    const cur = current.slice('level:'.length);
    if (!out.includes(cur)) out.push(cur);
  }
  return out;
}

/** 値からパラメータの差分を作る(他のパラメータはそのまま) */
export function applyThinkValue(params: ChatParams, v: string): ChatParams {
  const next: ChatParams = { ...params };
  delete next.think;
  delete next.reasoningEffort;
  if (v === 'off') next.think = false;
  else if (v === 'on') next.think = true;
  else if (v.startsWith('level:')) {
    next.think = true;
    next.reasoningEffort = v.slice('level:'.length);
  }
  return next;
}

/**
 * 入力欄の思考(thinking)切替。選んだ瞬間に会話へ保存する。
 * レベルは capability(テンプレートから検出)にあるものを候補に出す。思考非対応と推定されたモデルでは出さない。
 */
export function ThinkingControl({ conversation }: { conversation: Conversation }) {
  const caps = useCapabilities(conversation.serverProfileId, conversation.model);
  const { update } = useConversationMutations();
  if (caps.data && !caps.data.reasoning) return null;
  const value = thinkValue(conversation.params);
  const levels = thinkLevelOptions(caps.data?.reasoningLevels ?? [], value);
  const active = value !== '' && value !== 'off';
  return (
    <label
      className={cn(
        'flex items-center gap-1 rounded-full border pl-2 text-[11px] transition-colors',
        active ? 'border-accent/60 bg-accent/15 text-fg' : 'border-border text-fg-muted',
      )}
      title="思考(thinking)の有無とレベル。選ぶとすぐ保存されます"
    >
      <Brain size={11} className="shrink-0" />
      <span className="sr-only">思考</span>
      <Select
        aria-label="思考"
        value={value}
        onChange={(e) =>
          update.mutate({
            id: conversation.id,
            patch: { params: applyThinkValue(conversation.params, e.target.value) },
          })
        }
        className="h-6 w-auto rounded-full border-0 bg-transparent py-0 pr-6 pl-1 text-[11px] focus-visible:ring-0"
      >
        <option value="">思考: 既定</option>
        <option value="on">思考: 有効</option>
        {levels.map((l) => (
          <option key={l} value={`level:${l}`}>
            思考: {l}
          </option>
        ))}
        <option value="off">思考: 無効</option>
      </Select>
    </label>
  );
}

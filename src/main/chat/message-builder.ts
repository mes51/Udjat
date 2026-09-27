import type { Capabilities, Conversation, Message, Part, ServerProfile } from '@shared/schemas';
import type { CanonicalMessage, ChatRequest, ToolDefinition } from '@main/providers';
import type { MediaResolver } from './media-resolver';

/**
 * DB のメッセージ列(root -> 葉)をプロバイダ向けの ChatRequest に変換する。
 * 添付のデコードは MediaResolver に委ねる(無ければテキスト注記に退避)。
 */

export interface BuildInput {
  conversation: Conversation;
  profile: ServerProfile;
  path: Message[];
  capabilities: Capabilities;
  tools?: ToolDefinition[];
  /** ツール利用の手引き(system の末尾に付ける。M19) */
  toolGuide?: string | null;
  /** thinking 系モデルの reasoning を履歴として送り返すか(既定: 送らない) */
  sendReasoning?: boolean;
  resolver?: MediaResolver;
  signal?: AbortSignal;
}

const COMPACTION_HEADER =
  '# Summary of the earlier conversation\n' +
  'The messages before this point were compacted into the following summary. Continue the conversation from here, treating the summary as what actually happened. Attachment / tool ids mentioned in it remain valid.\n\n';

/** パスを「最後の compaction 以降の履歴」と「その要約文」に分ける */
export function splitAtCompaction(path: Message[]): { history: Message[]; summary: string | null } {
  let idx = -1;
  for (let i = path.length - 1; i >= 0; i--) {
    if (path[i]!.kind === 'compaction') {
      idx = i;
      break;
    }
  }
  if (idx === -1) return { history: path, summary: null };
  const summary = path[idx]!.parts.filter((p) => p.type === 'text')
    .map((p) => p.text)
    .join('\n')
    .trim();
  return { history: path.slice(idx + 1), summary: summary || null };
}

export function resolveModel(conversation: Conversation, profile: ServerProfile): string | null {
  return conversation.model ?? profile.defaultModel;
}

export async function buildChatRequest(input: BuildInput): Promise<ChatRequest> {
  const { conversation, profile, path, capabilities } = input;
  const model = resolveModel(conversation, profile);
  if (!model) throw new Error('モデルが選択されていません');

  const messages: CanonicalMessage[] = [];
  // コンパクション(M14): パス上の最後の要約ノードより前は送らず、要約を system の末尾に付ける
  const { history, summary } = splitAtCompaction(path);
  const system = [
    conversation.systemPrompt?.trim(),
    input.tools && input.tools.length > 0 ? input.toolGuide : null,
    summary && COMPACTION_HEADER + summary,
  ]
    .filter((s): s is string => !!s)
    .join('\n\n');
  if (system) messages.push({ role: 'system', text: system });

  for (const m of history) {
    if (m.kind === 'note') continue;
    const cm = await toCanonical(
      m,
      input.sendReasoning ?? false,
      capabilities,
      input.resolver,
      input.signal,
    );
    // 失敗して本文が空のままの assistant メッセージは履歴から除く
    if (
      m.role === 'assistant' &&
      !cm.text &&
      !cm.reasoning &&
      !(cm.toolCalls && cm.toolCalls.length > 0)
    )
      continue;
    messages.push(cm);
  }

  const req: ChatRequest = {
    model,
    messages,
    params: { ...profile.defaultParams, ...conversation.params },
    capabilities,
  };
  if (input.tools && input.tools.length > 0) req.tools = input.tools;
  return req;
}

async function toCanonical(
  m: Message,
  sendReasoning: boolean,
  caps: Capabilities,
  resolver: MediaResolver | undefined,
  signal: AbortSignal | undefined,
): Promise<CanonicalMessage> {
  const texts: string[] = [];
  const reasoning: string[] = [];
  const cm: CanonicalMessage = { role: m.role, text: '' };
  for (const p of m.parts) {
    if (p.type === 'text') texts.push(p.text);
    else if (p.type === 'reasoning') reasoning.push(p.text);
    else if (resolver) {
      const r = await resolver.resolve(p, caps, signal);
      if (r.text) texts.push(r.text);
      if (r.image) (cm.images ??= []).push(r.image);
      if (r.video) (cm.video ??= []).push(r.video);
      if (r.audio) (cm.audio ??= []).push(r.audio);
    } else texts.push(attachmentNote(p));
  }
  cm.text = texts.join('\n');
  if (sendReasoning && reasoning.length > 0) cm.reasoning = reasoning.join('\n');
  if (m.toolCalls && m.toolCalls.length > 0) cm.toolCalls = m.toolCalls;
  if (m.toolCallId) cm.toolCallId = m.toolCallId;
  const toolName = (m.toolMeta as { name?: unknown } | null)?.name;
  if (m.role === 'tool' && typeof toolName === 'string') cm.name = toolName;
  return cm;
}

function attachmentNote(p: Exclude<Part, { type: 'text' } | { type: 'reasoning' }>): string {
  const label = { image: '画像', audio: '音声', video: '動画', file: 'ファイル' }[p.type];
  return `[添付${label}: ${p.name ?? p.attachmentId}]`;
}

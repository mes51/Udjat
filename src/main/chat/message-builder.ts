import type { Capabilities, Conversation, Message, Part, ServerProfile } from '@shared/schemas';
import type { CanonicalMessage, ChatRequest, ToolDefinition } from '@main/providers';

/**
 * DB のメッセージ列(root -> 葉)をプロバイダ向けの ChatRequest に変換する。
 * 添付のデコード(M3)は MediaResolver に委ね、M1 では添付をテキスト注記に退避する。
 */

export interface BuildInput {
  conversation: Conversation;
  profile: ServerProfile;
  path: Message[];
  capabilities: Capabilities;
  tools?: ToolDefinition[];
  /** thinking 系モデルの reasoning を履歴として送り返すか(既定: 送らない) */
  sendReasoning?: boolean;
}

export function resolveModel(conversation: Conversation, profile: ServerProfile): string | null {
  return conversation.model ?? profile.defaultModel;
}

export function buildChatRequest(input: BuildInput): ChatRequest {
  const { conversation, profile, path, capabilities } = input;
  const model = resolveModel(conversation, profile);
  if (!model) throw new Error('モデルが選択されていません');

  const messages: CanonicalMessage[] = [];
  const system = conversation.systemPrompt?.trim();
  if (system) messages.push({ role: 'system', text: system });

  for (const m of path) {
    if (m.kind === 'note') continue;
    const cm = toCanonical(m, input.sendReasoning ?? false);
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

function toCanonical(m: Message, sendReasoning: boolean): CanonicalMessage {
  const texts: string[] = [];
  const reasoning: string[] = [];
  for (const p of m.parts) {
    if (p.type === 'text') texts.push(p.text);
    else if (p.type === 'reasoning') reasoning.push(p.text);
    else texts.push(attachmentNote(p));
  }
  const cm: CanonicalMessage = { role: m.role, text: texts.join('\n') };
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

import type {
  Capabilities,
  ChatEvent,
  ChatRunEvent,
  Message,
  ModelInfo,
  Part,
  ServerProfile,
  Usage,
} from '@shared/schemas';
import type { ConversationRepository } from '@main/db/repositories/conversations';
import type { MessageRepository } from '@main/db/repositories/messages';
import type { ServerProfileRepository } from '@main/db/repositories/server-profiles';
import { getAdapter, resolveCapabilities } from '@main/providers';
import { newId } from '@main/util/id';
import { buildChatRequest, resolveModel } from './message-builder';

export interface ChatServiceDeps {
  profiles: ServerProfileRepository;
  conversations: ConversationRepository;
  messages: MessageRepository;
  emit: (event: ChatRunEvent) => void;
  /** DB への途中保存の間隔(ミリ秒) */
  flushIntervalMs?: number;
}

export interface SendInput {
  conversationId: string;
  text: string;
  /** 省略時は会話の active_leaf の下に追加する */
  parentId?: string | null;
}

export interface RunHandle {
  runId: string;
  conversationId: string;
  userMessageId: string | null;
  assistantMessageId: string;
}

interface ActiveRun {
  controller: AbortController;
  conversationId: string;
  messageId: string;
  done: Promise<void>;
}

/**
 * 送信 -> ストリーム -> 保存 のオーケストレーション。
 * ツール呼び出しループは M2 で run() に追加する(docs/plan/04-tools-and-mcp.md)。
 */
export class ChatService {
  private readonly runs = new Map<string, ActiveRun>();
  private readonly modelInfoCache = new Map<string, ModelInfo | null>();

  constructor(private readonly deps: ChatServiceDeps) {}

  /** ユーザー発言を追加して応答を開始する */
  async send(input: SendInput): Promise<RunHandle> {
    const { conversations, messages } = this.deps;
    const conv = conversations.get(input.conversationId);
    if (!conv) throw new Error('会話が見つかりません');
    const profile = this.requireProfile(conv.serverProfileId);

    const parentId = input.parentId === undefined ? conv.activeLeafId : input.parentId;
    const user = messages.create({
      conversationId: conv.id,
      parentId,
      role: 'user',
      parts: [{ type: 'text', text: input.text }],
    });
    const assistant = messages.create({
      conversationId: conv.id,
      parentId: user.id,
      role: 'assistant',
      parts: [],
      model: resolveModel(conv, profile),
    });
    conversations.update(conv.id, {
      activeLeafId: assistant.id,
      ...(conv.title.trim() === '' ? { title: makeTitle(input.text) } : {}),
    });

    const runId = this.start(conv.id, profile, assistant);
    return {
      runId,
      conversationId: conv.id,
      userMessageId: user.id,
      assistantMessageId: assistant.id,
    };
  }

  /** assistant メッセージを同じ親の下に作り直す(分岐) */
  async regenerate(messageId: string): Promise<RunHandle> {
    const { conversations, messages } = this.deps;
    const target = messages.get(messageId);
    if (!target || target.role !== 'assistant')
      throw new Error('再生成できるのは assistant メッセージだけです');
    const conv = conversations.get(target.conversationId);
    if (!conv) throw new Error('会話が見つかりません');
    const profile = this.requireProfile(conv.serverProfileId);
    const assistant = messages.create({
      conversationId: conv.id,
      parentId: target.parentId,
      role: 'assistant',
      parts: [],
      model: resolveModel(conv, profile),
    });
    conversations.update(conv.id, { activeLeafId: assistant.id });
    const runId = this.start(conv.id, profile, assistant);
    return {
      runId,
      conversationId: conv.id,
      userMessageId: null,
      assistantMessageId: assistant.id,
    };
  }

  abort(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    run.controller.abort(new Error('aborted by user'));
    return true;
  }

  abortAll(): void {
    for (const id of [...this.runs.keys()]) this.abort(id);
  }

  /** テスト用: 実行中の run の完了を待つ */
  async waitFor(runId: string): Promise<void> {
    await this.runs.get(runId)?.done;
  }

  isRunning(conversationId: string): string | null {
    for (const [id, r] of this.runs) if (r.conversationId === conversationId) return id;
    return null;
  }

  async capabilitiesFor(profile: ServerProfile, model: string): Promise<Capabilities> {
    const info = await this.describeModel(profile, model);
    return resolveCapabilities(
      profile.kind,
      model,
      info?.capabilities,
      profile.capabilityOverrides,
    );
  }

  private requireProfile(id: string | null): ServerProfile {
    const profile = id ? this.deps.profiles.get(id) : null;
    if (!profile) throw new Error('サーバープロファイルが設定されていません');
    return profile;
  }

  private async describeModel(profile: ServerProfile, model: string): Promise<ModelInfo | null> {
    const key = `${profile.id}\u0000${profile.baseUrl}\u0000${model}`;
    if (this.modelInfoCache.has(key)) return this.modelInfoCache.get(key) ?? null;
    let info: ModelInfo | null = null;
    try {
      info = await getAdapter(profile.kind).describeModel(profile, model);
    } catch {
      info = null;
    }
    this.modelInfoCache.set(key, info);
    return info;
  }

  private start(conversationId: string, profile: ServerProfile, assistant: Message): string {
    const runId = newId();
    const controller = new AbortController();
    const done = this.run(runId, conversationId, profile, assistant, controller.signal).finally(
      () => {
        this.runs.delete(runId);
      },
    );
    this.runs.set(runId, { controller, conversationId, messageId: assistant.id, done });
    return runId;
  }

  private async run(
    runId: string,
    conversationId: string,
    profile: ServerProfile,
    assistant: Message,
    signal: AbortSignal,
  ): Promise<void> {
    const { conversations, messages } = this.deps;
    const emit = (event: ChatEvent) =>
      this.deps.emit({ runId, conversationId, messageId: assistant.id, event });

    let text = '';
    let reasoning = '';
    let usage: Usage | null = null;
    let lastFlush = Date.now();
    const flushInterval = this.deps.flushIntervalMs ?? 300;
    const parts = (): Part[] => [
      ...(reasoning ? [{ type: 'reasoning' as const, text: reasoning }] : []),
      ...(text ? [{ type: 'text' as const, text }] : []),
    ];

    try {
      const conv = conversations.get(conversationId);
      if (!conv) throw new Error('会話が見つかりません');
      const model = resolveModel(conv, profile);
      if (!model) throw new Error('モデルが選択されていません');
      const capabilities = await this.capabilitiesFor(profile, model);
      const path = messages.pathToRoot(assistant.id).slice(0, -1); // 自分自身(空の assistant)は除く
      const req = buildChatRequest({ conversation: conv, profile, path, capabilities });

      for await (const ev of getAdapter(profile.kind).chat(profile, req, signal)) {
        if (ev.type === 'text-delta') text += ev.text;
        else if (ev.type === 'reasoning-delta') reasoning += ev.text;
        else if (ev.type === 'usage') usage = ev.usage;
        emit(ev);
        if (ev.type === 'error') {
          messages.update(assistant.id, {
            parts: parts(),
            usage,
            finishReason: 'error',
            error: ev.message,
          });
          emit({ type: 'done', finishReason: 'error' });
          return;
        }
        if (ev.type === 'done') {
          messages.update(assistant.id, {
            parts: parts(),
            usage,
            finishReason: ev.finishReason,
            error: null,
          });
          conversations.update(conversationId, {});
          return;
        }
        if (Date.now() - lastFlush > flushInterval) {
          messages.update(assistant.id, { parts: parts() });
          lastFlush = Date.now();
        }
      }
      // done を受け取らずに終了した(接続断など)
      messages.update(assistant.id, { parts: parts(), usage, finishReason: 'stop' });
      emit({ type: 'done', finishReason: 'stop' });
    } catch (e) {
      const aborted = signal.aborted;
      const message = aborted ? '' : (e as Error).message;
      messages.update(assistant.id, {
        parts: parts(),
        usage,
        finishReason: aborted ? 'aborted' : 'error',
        error: aborted ? null : message,
      });
      if (!aborted) emit({ type: 'error', message });
      emit({ type: 'done', finishReason: aborted ? 'aborted' : 'error' });
    }
  }
}

function makeTitle(text: string): string {
  const line = text.trim().split(/\r?\n/)[0] ?? '';
  const chars = [...line];
  return chars.length > 40 ? chars.slice(0, 40).join('') + '…' : line;
}

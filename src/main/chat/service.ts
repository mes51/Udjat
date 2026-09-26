import type {
  Attachment,
  AttachmentRef,
  Capabilities,
  ChatEvent,
  ChatRunEvent,
  FinishReason,
  Message,
  ModelInfo,
  Part,
  ServerProfile,
  ToolApprovalDecision,
  ToolCall,
  ToolMeta,
  Usage,
} from '@shared/schemas';
import type { AttachmentRepository } from '@main/db/repositories/attachments';
import type { ConversationRepository } from '@main/db/repositories/conversations';
import type { MediaStore } from '@main/media/store';
import type { VideoOps } from '@main/media/video-ops';
import type { MediaResolver } from './media-resolver';
import type { MessageRepository } from '@main/db/repositories/messages';
import type { ServerProfileRepository } from '@main/db/repositories/server-profiles';
import { getAdapter, resolveCapabilities } from '@main/providers';
import type { ToolRegistry } from '@main/tools/registry';
import { parseToolArgs } from '@main/tools/registry';
import type { ToolResult } from '@main/tools/types';
import { newId } from '@main/util/id';
import { buildChatRequest, resolveModel } from './message-builder';

export interface ChatServiceDeps {
  profiles: ServerProfileRepository;
  conversations: ConversationRepository;
  messages: MessageRepository;
  tools: ToolRegistry;
  emit: (event: ChatRunEvent) => void;
  getSetting?: (key: string) => unknown;
  /** 添付まわり。無ければ添付は扱えない(テスト用) */
  media?: MediaServices;
  /** DB への途中保存の間隔(ミリ秒) */
  flushIntervalMs?: number;
  /** ツール呼び出しループの最大反復回数 */
  maxToolIterations?: number;
  /** 動画添付時にコンタクトシートを自動添付するか(既定 true) */
  autoContactSheet?: boolean;
}

export interface MediaServices {
  store: MediaStore;
  ops: VideoOps;
  attachments: AttachmentRepository;
  resolver: MediaResolver;
}

export interface SendInput {
  conversationId: string;
  text: string;
  attachments?: AttachmentRef[];
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
  done: Promise<void>;
}

interface StreamOutcome {
  finishReason: FinishReason;
  toolCalls: ToolCall[];
}

/**
 * 送信 -> ストリーム -> (ツール実行 -> 再送)* -> 保存 のオーケストレーション。
 * 設計は docs/plan/04-tools-and-mcp.md を参照。
 */
export class ChatService {
  private readonly runs = new Map<string, ActiveRun>();
  private readonly modelInfoCache = new Map<string, ModelInfo | null>();
  private readonly pendingApprovals = new Map<string, (d: ToolApprovalDecision) => void>();
  /** 会話単位で「この会話では常に許可」されたツール名 */
  private readonly conversationAllow = new Map<string, Set<string>>();

  constructor(private readonly deps: ChatServiceDeps) {}

  /** ユーザー発言を追加して応答を開始する */
  async send(input: SendInput): Promise<RunHandle> {
    const { conversations, messages } = this.deps;
    const conv = conversations.get(input.conversationId);
    if (!conv) throw new Error('会話が見つかりません');
    const profile = this.requireProfile(conv.serverProfileId);

    const refs = input.attachments ?? [];
    if (input.text.trim() === '' && refs.length === 0) throw new Error('メッセージが空です');
    const { parts, linked } = await this.attachmentParts(refs);
    const userParts: Part[] = [
      ...(input.text ? [{ type: 'text' as const, text: input.text }] : []),
      ...parts,
    ];

    const parentId = input.parentId === undefined ? conv.activeLeafId : input.parentId;
    const user = messages.create({
      conversationId: conv.id,
      parentId,
      role: 'user',
      parts: userParts,
    });
    for (const a of linked) this.deps.media?.attachments.link(user.id, a.id);
    const assistant = messages.create({
      conversationId: conv.id,
      parentId: user.id,
      role: 'assistant',
      parts: [],
      model: resolveModel(conv, profile),
    });
    conversations.update(conv.id, {
      activeLeafId: assistant.id,
      ...(conv.title.trim() === ''
        ? { title: makeTitle(input.text || linked[0]?.originalName || '') }
        : {}),
    });

    const runId = this.start(conv.id, profile, assistant);
    return {
      runId,
      conversationId: conv.id,
      userMessageId: user.id,
      assistantMessageId: assistant.id,
    };
  }

  /**
   * 添付参照をメッセージのパートに変換する。動画は既定でコンタクトシートを 1 枚添える
   * (docs/plan/03-video-and-attachments.md)。
   */
  private async attachmentParts(
    refs: AttachmentRef[],
  ): Promise<{ parts: Part[]; linked: Attachment[] }> {
    const parts: Part[] = [];
    const linked: Attachment[] = [];
    if (refs.length === 0) return { parts, linked };
    const media = this.deps.media;
    if (!media) throw new Error('添付はこの構成では扱えません');
    for (const ref of refs) {
      const a = media.store.get(ref.id);
      if (!a) throw new Error(`添付が見つかりません: ${ref.id}`);
      linked.push(a);
      const kind = a.meta.kind;
      if (kind === 'video') {
        parts.push({
          type: 'video',
          attachmentId: a.id,
          name: a.originalName,
          sendMode: ref.sendMode ?? 'tools',
        });
        if (
          (this.deps.autoContactSheet ?? true) &&
          (ref.sendMode ?? 'tools') === 'tools' &&
          !a.meta.probeError
        ) {
          try {
            const { sheet } = await media.ops.contactSheet(a);
            parts.push({
              type: 'image',
              attachmentId: sheet.id,
              name: `${a.originalName} (contact sheet)`,
            });
            linked.push(sheet);
          } catch (e) {
            parts.push({
              type: 'text',
              text: `[コンタクトシートの生成に失敗: ${(e as Error).message.slice(0, 200)}]`,
            });
          }
        }
      } else if (kind === 'image')
        parts.push({ type: 'image', attachmentId: a.id, name: a.originalName });
      else if (kind === 'audio')
        parts.push({ type: 'audio', attachmentId: a.id, name: a.originalName });
      else parts.push({ type: 'file', attachmentId: a.id, name: a.originalName });
    }
    return { parts, linked };
  }

  /** assistant メッセージを同じ親の下に作り直す(分岐) */
  async regenerate(messageId: string): Promise<RunHandle> {
    const { conversations, messages } = this.deps;
    const target = messages.get(messageId);
    if (!target || target.role !== 'assistant') {
      throw new Error('再生成できるのは assistant メッセージだけです');
    }
    const conv = conversations.get(target.conversationId);
    if (!conv) throw new Error('会話が見つかりません');
    if (this.isRunning(conv.id)) throw new Error('この会話は応答生成中です');
    const profile = this.requireProfile(conv.serverProfileId);
    // ツール呼び出しを含む応答は複数セグメントに分かれているので、直前のユーザー発言まで遡って
    // そこから作り直す(途中のツール結果は新しい分岐には含めない)
    const ancestors = messages.pathToRoot(target.id);
    // kind: tool-media もロール上は user だが、ツール結果の配送なので遡る対象にしない
    const lastUser = [...ancestors].reverse().find((m) => m.role === 'user' && m.kind === 'normal');
    const parentId = lastUser ? lastUser.id : target.parentId;
    const assistant = messages.create({
      conversationId: conv.id,
      parentId,
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

  /** 承認待ちのツール呼び出しに回答する */
  approve(runId: string, callId: string, decision: ToolApprovalDecision): boolean {
    const resolve = this.pendingApprovals.get(`${runId}\u0000${callId}`);
    if (!resolve) return false;
    resolve(decision);
    return true;
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
      profile.modelCapabilityOverrides[model] ?? {},
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
    this.runs.set(runId, { controller, conversationId, done });
    return runId;
  }

  private async run(
    runId: string,
    conversationId: string,
    profile: ServerProfile,
    firstAssistant: Message,
    signal: AbortSignal,
  ): Promise<void> {
    const { conversations, messages, tools } = this.deps;
    const maxIterations = this.deps.maxToolIterations ?? 10;
    const counters = new Map<string, number>();
    let assistant = firstAssistant;
    const emit = (event: ChatEvent) =>
      this.deps.emit({ runId, conversationId, messageId: assistant.id, event });

    try {
      const conv = conversations.get(conversationId);
      if (!conv) throw new Error('会話が見つかりません');
      const model = resolveModel(conv, profile);
      if (!model) throw new Error('モデルが選択されていません');
      const capabilities = await this.capabilitiesFor(profile, model);
      const toolDefs = capabilities.tools
        ? tools.definitionsFor(capabilities, conv.enabledTools)
        : [];

      for (let iteration = 0; ; iteration++) {
        const outcome = await this.streamAssistant(
          assistant,
          profile,
          capabilities,
          toolDefs,
          signal,
          emit,
        );
        if (outcome.finishReason !== 'tool_calls' || outcome.toolCalls.length === 0) return;
        if (iteration >= maxIterations - 1) {
          messages.create({
            conversationId,
            parentId: assistant.id,
            role: 'assistant',
            kind: 'note',
            parts: [
              {
                type: 'text',
                text: `ツール呼び出しの上限 (${maxIterations} 回) に達したため停止しました`,
              },
            ],
          });
          emit({ type: 'path-changed' });
          return;
        }

        // --- ツール実行 ---
        let parentId = assistant.id;
        for (const call of outcome.toolCalls) {
          const { lastId } = await this.executeToolCall(call, {
            runId,
            conversationId,
            parentId,
            signal,
            counters,
            emit,
          });
          parentId = lastId;
        }

        // --- 次の assistant セグメント ---
        assistant = messages.create({
          conversationId,
          parentId,
          role: 'assistant',
          parts: [],
          model,
        });
        conversations.update(conversationId, { activeLeafId: assistant.id });
        emit({ type: 'path-changed' });
      }
    } catch (e) {
      const aborted = signal.aborted;
      const message = aborted ? '' : (e as Error).message;
      const cur = messages.get(assistant.id);
      if (cur && cur.finishReason === null) {
        messages.update(assistant.id, {
          finishReason: aborted ? 'aborted' : 'error',
          error: aborted ? null : message,
        });
      }
      if (!aborted) emit({ type: 'error', message });
      emit({ type: 'done', finishReason: aborted ? 'aborted' : 'error' });
    } finally {
      emit({ type: 'run-end' });
    }
  }

  /** 1 セグメント分の assistant 応答をストリームして保存する */
  private async streamAssistant(
    assistant: Message,
    profile: ServerProfile,
    capabilities: Capabilities,
    toolDefs: ReturnType<ToolRegistry['definitionsFor']>,
    signal: AbortSignal,
    emit: (event: ChatEvent) => void,
  ): Promise<StreamOutcome> {
    const { conversations, messages } = this.deps;
    const conv = conversations.get(assistant.conversationId);
    if (!conv) throw new Error('会話が見つかりません');

    let text = '';
    let reasoning = '';
    let usage: Usage | null = null;
    const toolCalls: ToolCall[] = [];
    let lastFlush = Date.now();
    const flushInterval = this.deps.flushIntervalMs ?? 300;
    const parts = (): Part[] => [
      ...(reasoning ? [{ type: 'reasoning' as const, text: reasoning }] : []),
      ...(text ? [{ type: 'text' as const, text }] : []),
    ];
    const finish = (finishReason: FinishReason, error: string | null = null): StreamOutcome => {
      messages.update(assistant.id, {
        parts: parts(),
        usage,
        finishReason,
        error,
        toolCalls: toolCalls.length > 0 ? toolCalls : null,
      });
      conversations.update(assistant.conversationId, {});
      return { finishReason, toolCalls };
    };

    const path = messages.pathToRoot(assistant.id).slice(0, -1); // 自分自身(空の assistant)は除く
    const req = await buildChatRequest({
      conversation: conv,
      profile,
      path,
      capabilities,
      tools: toolDefs,
      signal,
      ...(this.deps.media ? { resolver: this.deps.media.resolver } : {}),
    });

    try {
      for await (const ev of getAdapter(profile.kind).chat(profile, req, signal)) {
        if (ev.type === 'text-delta') text += ev.text;
        else if (ev.type === 'reasoning-delta') reasoning += ev.text;
        else if (ev.type === 'usage') usage = ev.usage;
        else if (ev.type === 'tool-call') toolCalls.push(ev.call);
        emit(ev);
        if (ev.type === 'error') {
          const out = finish('error', ev.message);
          emit({ type: 'done', finishReason: 'error' });
          return out;
        }
        if (ev.type === 'done') return finish(ev.finishReason);
        if (Date.now() - lastFlush > flushInterval) {
          messages.update(assistant.id, { parts: parts() });
          lastFlush = Date.now();
        }
      }
      // done を受け取らずに終了した(接続断など)
      const out = finish('stop');
      emit({ type: 'done', finishReason: 'stop' });
      return out;
    } catch (e) {
      // 途中までの本文を残してから上位に投げる
      messages.update(assistant.id, { parts: parts(), usage });
      throw e;
    }
  }

  private async executeToolCall(
    call: ToolCall,
    ctx: {
      runId: string;
      conversationId: string;
      parentId: string;
      signal: AbortSignal;
      counters: Map<string, number>;
      emit: (event: ChatEvent) => void;
    },
  ): Promise<{ lastId: string; result: ToolResult }> {
    const { messages, tools } = this.deps;
    const startedAt = Date.now();

    // 承認
    const policy = tools.policyFor(call.name);
    let approval: ToolMeta['approval'] = 'auto';
    if (policy === 'deny') {
      approval = 'denied';
    } else if (
      policy === 'ask' &&
      !this.conversationAllow.get(ctx.conversationId)?.has(call.name)
    ) {
      ctx.emit({ type: 'tool-approval-request', call });
      const decision = await this.awaitApproval(ctx.runId, call.id, ctx.signal);
      if (decision === 'deny') approval = 'denied';
      else if (decision === 'allow-conversation') {
        approval = 'approved-conversation';
        let set = this.conversationAllow.get(ctx.conversationId);
        if (!set) this.conversationAllow.set(ctx.conversationId, (set = new Set()));
        set.add(call.name);
      } else approval = 'approved';
    }

    let result: ToolResult;
    ctx.emit({ type: 'tool-start', call });
    if (approval === 'denied') {
      result = {
        text:
          policy === 'deny'
            ? 'error: このツールは設定で無効化されています'
            : 'error: ユーザーが実行を拒否しました',
        isError: true,
      };
    } else {
      const parsed = parseToolArgs(call.args);
      if (parsed.error) result = { text: `error: ${parsed.error}`, isError: true };
      else {
        result = await tools.execute(call.name, parsed.args, {
          conversationId: ctx.conversationId,
          runId: ctx.runId,
          signal: ctx.signal,
          counters: ctx.counters,
          getSetting: this.deps.getSetting ?? (() => null),
        });
      }
    }
    const durationMs = Date.now() - startedAt;
    ctx.emit({ type: 'tool-end', callId: call.id, isError: result.isError ?? false, durationMs });

    const meta: ToolMeta = {
      name: call.name,
      args: call.args,
      durationMs,
      isError: result.isError ?? false,
      approval,
    };
    const toolMsg = messages.create({
      conversationId: ctx.conversationId,
      parentId: ctx.parentId,
      role: 'tool',
      parts: [{ type: 'text', text: result.text }],
      toolCallId: call.id,
      toolMeta: meta,
    });
    // 画像・動画を含む結果は、tool メッセージの直後に user メッセージ(kind: tool-media)として配送する
    // (role: tool に画像を入れられないサーバーが多いため。docs/plan/03 参照)
    const mediaList = result.media ?? [];
    if (mediaList.length === 0 || !this.deps.media) return { lastId: toolMsg.id, result };
    const parts: Part[] = [{ type: 'text', text: `[tool result media: ${call.name}]` }];
    for (const m of mediaList) {
      if (m.kind === 'video')
        parts.push({
          type: 'video',
          attachmentId: m.attachmentId,
          name: m.label,
          sendMode: 'native',
        });
      else parts.push({ type: 'image', attachmentId: m.attachmentId, name: m.label });
    }
    const mediaMsg = messages.create({
      conversationId: ctx.conversationId,
      parentId: toolMsg.id,
      role: 'user',
      kind: 'tool-media',
      parts,
    });
    for (const m of mediaList) this.deps.media.attachments.link(mediaMsg.id, m.attachmentId);
    return { lastId: mediaMsg.id, result };
  }

  private awaitApproval(
    runId: string,
    callId: string,
    signal: AbortSignal,
  ): Promise<ToolApprovalDecision> {
    const key = `${runId}\u0000${callId}`;
    return new Promise<ToolApprovalDecision>((resolve, reject) => {
      const onAbort = () => {
        this.pendingApprovals.delete(key);
        reject(signal.reason ?? new Error('aborted'));
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      this.pendingApprovals.set(key, (d) => {
        signal.removeEventListener('abort', onAbort);
        this.pendingApprovals.delete(key);
        resolve(d);
      });
    });
  }
}

function makeTitle(text: string): string {
  const line = text.trim().split(/\r?\n/)[0] ?? '';
  const chars = [...line];
  return chars.length > 40 ? chars.slice(0, 40).join('') + '…' : line;
}

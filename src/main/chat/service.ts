import type {
  Attachment,
  AttachmentRef,
  BackgroundTask,
  Capabilities,
  ChatEvent,
  ChatRunEvent,
  ContextUsage,
  FinishReason,
  Message,
  ModelInfo,
  ModelStatus,
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
import { buildToolGuide } from '@main/tools/guide';
import type { ToolResult } from '@main/tools/types';
import { newId } from '@main/util/id';
import { fmt } from '@main/media/video-ops';
import { buildChatRequest, resolveModel, splitAtCompaction } from './message-builder';
import { estimateTokens, IMAGE_TOKENS } from '@shared/tokens';

function fmtRange(r: { startMs: number; endMs: number }): string {
  return `${fmt(r.startMs)}-${fmt(r.endMs)}`;
}

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

/** 切り離したツール呼び出し(M16) */
interface BackgroundEntry {
  conversationId: string;
  callId: string;
  messageId: string;
  name: string;
  startedAt: number;
  runId: string;
  controller: AbortController;
}

/** 承認カードの回答(M15: 拒否には理由が付く) */
interface ApprovalAnswer {
  decision: ToolApprovalDecision;
  reason?: string;
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
  private readonly pendingApprovals = new Map<string, (d: ApprovalAnswer) => void>();
  /** 会話単位で「この会話では常に許可」されたツール名 */
  private readonly conversationAllow = new Map<string, Set<string>>();
  /** モデル管理に非対応と判明したプロファイル(profileId+baseUrl -> 再確認してよい時刻) */
  private readonly unsupportedUntil = new Map<string, number>();
  /** 切り離したツール呼び出し(M16)。キーは conversationId + callId */
  private readonly background = new Map<string, BackgroundEntry>();

  constructor(private readonly deps: ChatServiceDeps) {
    // 前回の終了で置き去りになったバックグラウンドタスクを lost にする
    for (const m of deps.messages.listBackgroundRunning()) {
      const meta = m.toolMeta as ToolMeta;
      deps.messages.update(m.id, {
        parts: [{ type: 'text', text: 'error: アプリの終了により中断されました' }],
        toolMeta: {
          ...meta,
          isError: true,
          background: { ...meta.background!, status: 'lost' },
        },
      });
    }
  }

  /** ユーザー発言を追加して応答を開始する */
  async send(input: SendInput): Promise<RunHandle> {
    const { conversations, messages } = this.deps;
    const conv = conversations.get(input.conversationId);
    if (!conv) throw new Error('会話が見つかりません');
    this.assertNoBackground(conv.id);
    const profile = this.requireProfile(conv.serverProfileId);

    const refs = input.attachments ?? [];
    if (input.text.trim() === '' && refs.length === 0) throw new Error('メッセージが空です');
    const { parts, linked } = await this.attachmentParts(refs);
    const userParts: Part[] = [
      ...(input.text ? [{ type: 'text' as const, text: input.text }] : []),
      ...parts,
    ];

    // 自動コンパクション(M14): active leaf の下に続ける時だけ。閾値を超えていれば先に要約ノードを挟む
    let baseLeafId = conv.activeLeafId;
    if (input.parentId === undefined && this.deps.getSetting?.('context.autoCompact') === true) {
      const compacted = await this.maybeAutoCompact(conv.id);
      if (compacted) baseLeafId = compacted;
    }
    const parentId = input.parentId === undefined ? baseLeafId : input.parentId;
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
          ...(ref.range ? { range: ref.range } : {}),
        });
        if (
          (this.deps.autoContactSheet ?? true) &&
          (ref.sendMode ?? 'tools') === 'tools' &&
          !a.meta.probeError
        ) {
          try {
            // 区間指定があればその区間だけを俯瞰するシートにする
            const { sheet } = await media.ops.contactSheet(
              a,
              ref.range ? { startMs: ref.range.startMs, endMs: ref.range.endMs } : {},
            );
            parts.push({
              type: 'image',
              attachmentId: sheet.id,
              name: `${a.originalName} (contact sheet${ref.range ? ` ${fmtRange(ref.range)}` : ''})`,
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

  /**
   * ユーザー発言を編集して送り直す。元のメッセージと同じ親の下に新しい分岐を作る。
   * 添付は引き継ぐ(自動生成されたコンタクトシート等の派生物は除く)。
   */
  async edit(messageId: string, text: string): Promise<RunHandle> {
    const { messages } = this.deps;
    const target = messages.get(messageId);
    if (!target || target.role !== 'user' || target.kind !== 'normal') {
      throw new Error('編集できるのはユーザーの発言だけです');
    }
    if (this.isRunning(target.conversationId)) throw new Error('この会話は応答生成中です');
    const attachments: AttachmentRef[] = [];
    for (const p of target.parts) {
      if (p.type === 'text' || p.type === 'reasoning') continue;
      const a = this.deps.media?.store.get(p.attachmentId);
      if (!a || a.meta.derivedFrom) continue;
      attachments.push({
        id: p.attachmentId,
        ...(p.type === 'video' && p.sendMode ? { sendMode: p.sendMode } : {}),
        ...(p.type === 'video' && p.range ? { range: p.range } : {}),
      });
    }
    return this.send({
      conversationId: target.conversationId,
      text,
      attachments,
      parentId: target.parentId,
    });
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
    this.assertNoBackground(conv.id);
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
    for (const e of this.background.values()) e.controller.abort(new Error('app quit'));
  }

  // ---------------------------------------------------------------------------
  // バックグラウンドタスク(M16。docs/plan/10-approval-background-sandbox.md)
  // ---------------------------------------------------------------------------

  /** 実行中のバックグラウンドタスク(conversationId 省略で全会話) */
  backgroundTasks(conversationId?: string): BackgroundTask[] {
    return [...this.background.values()]
      .filter((e) => !conversationId || e.conversationId === conversationId)
      .map((e) => ({
        conversationId: e.conversationId,
        callId: e.callId,
        messageId: e.messageId,
        name: e.name,
        startedAt: e.startedAt,
      }));
  }

  hasBackground(conversationId: string): boolean {
    for (const e of this.background.values()) if (e.conversationId === conversationId) return true;
    return false;
  }

  private assertNoBackground(conversationId: string): void {
    if (this.hasBackground(conversationId))
      throw new Error('この会話はバックグラウンドタスクの完了を待っています(中断もできます)');
  }

  /** バックグラウンドタスクを中断する。結果はエラーとして記録し、応答は再開しない */
  abortTask(conversationId: string, callId: string): boolean {
    const e = this.background.get(`${conversationId}\u0000${callId}`);
    if (!e) return false;
    e.controller.abort(new Error('aborted by user'));
    return true;
  }

  /** 切り離したツール呼び出しが終わった時の後処理: 結果を書き込み、条件が揃えば応答を再開する */
  private finishBackground(key: string, result: ToolResult): void {
    const { conversations, messages } = this.deps;
    const e = this.background.get(key);
    if (!e) return;
    this.background.delete(key);
    const aborted = e.controller.signal.aborted;
    const msg = messages.get(e.messageId);
    if (!msg) return;
    const meta = msg.toolMeta as ToolMeta;
    const finalResult: ToolResult = aborted
      ? { text: 'error: ユーザーがバックグラウンドタスクを中断しました', isError: true }
      : result;
    messages.update(e.messageId, {
      parts: [{ type: 'text', text: finalResult.text }],
      toolMeta: {
        ...meta,
        durationMs: Date.now() - e.startedAt,
        isError: finalResult.isError ?? false,
        background: { status: aborted ? 'aborted' : 'done', startedAt: e.startedAt },
      },
    });
    const emit = (event: ChatEvent) =>
      this.deps.emit({
        runId: e.runId,
        conversationId: e.conversationId,
        messageId: e.messageId,
        event,
      });

    const conv = conversations.get(e.conversationId);
    const onActivePath =
      !!conv?.activeLeafId &&
      messages.pathToRoot(conv.activeLeafId).some((m) => m.id === e.messageId);
    let leafId = conv?.activeLeafId ?? null;
    if (conv && onActivePath && leafId) {
      const mediaMsg = this.deliverMedia(e.conversationId, leafId, e.name, finalResult);
      if (mediaMsg) {
        leafId = mediaMsg.id;
        conversations.update(conv.id, { activeLeafId: leafId });
      }
      if (aborted) {
        const note = messages.create({
          conversationId: conv.id,
          parentId: leafId,
          role: 'assistant',
          kind: 'note',
          parts: [{ type: 'text', text: `バックグラウンドタスク ${e.name} を中断しました` }],
        });
        conversations.update(conv.id, { activeLeafId: note.id });
      }
    }
    emit({ type: 'tool-background', state: 'end', callId: e.callId, messageId: e.messageId });

    // 同じ会話の他のタスクが全部終わり、末尾がまだツール結果なら assistant を作って続きを生成する
    if (aborted || !conv || !onActivePath || !leafId || this.hasBackground(conv.id)) return;
    if (this.isRunning(conv.id)) return;
    const last = messages.get(leafId);
    if (!last || !(last.role === 'tool' || last.kind === 'tool-media')) return;
    const profile = this.deps.profiles.get(conv.serverProfileId ?? '');
    if (!profile) return;
    const assistant = messages.create({
      conversationId: conv.id,
      parentId: leafId,
      role: 'assistant',
      parts: [],
      model: resolveModel(conv, profile),
    });
    conversations.update(conv.id, { activeLeafId: assistant.id });
    this.start(conv.id, profile, assistant);
  }

  /** 画像・動画を含むツール結果を tool-media メッセージとして末尾に足す(無ければ null) */
  private deliverMedia(
    conversationId: string,
    parentId: string,
    toolName: string,
    result: ToolResult,
  ): Message | null {
    const mediaList = result.media ?? [];
    if (mediaList.length === 0 || !this.deps.media) return null;
    const parts: Part[] = [{ type: 'text', text: `[tool result media: ${toolName}]` }];
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
    const mediaMsg = this.deps.messages.create({
      conversationId,
      parentId,
      role: 'user',
      kind: 'tool-media',
      parts,
    });
    for (const m of mediaList) this.deps.media.attachments.link(mediaMsg.id, m.attachmentId);
    return mediaMsg;
  }

  /** 承認待ちのツール呼び出しに回答する。reason は拒否の理由(M15) */
  approve(runId: string, callId: string, decision: ToolApprovalDecision, reason?: string): boolean {
    const resolve = this.pendingApprovals.get(`${runId}\u0000${callId}`);
    if (!resolve) return false;
    const trimmed = reason?.trim();
    resolve({ decision, ...(trimmed ? { reason: trimmed } : {}) });
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

  /** サーバーのモデル常駐状態(対応しない種別なら supported: false) */
  async modelStatus(profile: ServerProfile, signal?: AbortSignal): Promise<ModelStatus> {
    const mgr = getAdapter(profile.kind).models;
    if (!mgr) return { supported: false, loaded: [], loading: [] };
    try {
      return await mgr.status(profile, signal);
    } catch {
      // 状態が取れない(エンドポイントが無い・落ちている)なら「操作できない」として扱う
      return { supported: false, loaded: [], loading: [] };
    }
  }

  async loadModel(
    profile: ServerProfile,
    model: string,
    signal?: AbortSignal,
  ): Promise<ModelStatus> {
    const mgr = getAdapter(profile.kind).models;
    if (!mgr) throw new Error('このサーバー種別ではモデルのロードを操作できません');
    const status = await mgr.status(profile, signal);
    if (profile.modelManagement.unloadOthers) {
      for (const other of status.loaded)
        if (other !== model) await mgr.unload(profile, other, signal);
    }
    if (!status.loaded.includes(model)) await mgr.load(profile, model, signal);
    return mgr.status(profile, signal);
  }

  async unloadModel(
    profile: ServerProfile,
    model: string,
    signal?: AbortSignal,
  ): Promise<ModelStatus> {
    const mgr = getAdapter(profile.kind).models;
    if (!mgr) throw new Error('このサーバー種別ではモデルのロードを操作できません');
    await mgr.unload(profile, model, signal);
    return mgr.status(profile, signal);
  }

  /**
   * 送信直前の自動ロード(M10)。プロファイルで autoLoad が有効で、サーバーが対応していて、
   * 選択中モデルが常駐していなければロードしてから進む。進行は model-load イベントで通知する。
   */
  private async ensureModelLoaded(
    profile: ServerProfile,
    model: string,
    emit: (event: ChatEvent) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const mgr = getAdapter(profile.kind).models;
    if (!mgr || !profile.modelManagement.autoLoad) return;
    // 非対応と分かったサーバーは、しばらく問い合わせを省く(単一モデル起動の llama.cpp など)
    const key = `${profile.id}\u0000${profile.baseUrl}`;
    const until = this.unsupportedUntil.get(key);
    if (until !== undefined && until > Date.now()) return;
    let status: ModelStatus;
    try {
      status = await mgr.status(profile, signal);
    } catch {
      if (signal.aborted)
        throw signal.reason instanceof Error ? signal.reason : new Error('aborted');
      this.unsupportedUntil.set(key, Date.now() + 60_000);
      return;
    }
    if (!status.supported) {
      this.unsupportedUntil.set(key, Date.now() + 60_000);
      return;
    }
    if (status.loaded.includes(model)) return;
    emit({ type: 'model-load', state: 'loading', model });
    try {
      await this.loadModel(profile, model, signal);
      emit({ type: 'model-load', state: 'done', model });
    } catch (e) {
      const message = (e as Error).message;
      emit({ type: 'model-load', state: 'error', model, message });
      throw new Error(`モデル ${model} のロードに失敗しました: ${message}`);
    }
  }

  private requireProfile(id: string | null): ServerProfile {
    const profile = id ? this.deps.profiles.get(id) : null;
    if (!profile) throw new Error('サーバープロファイルが設定されていません');
    return profile;
  }

  // ---------------------------------------------------------------------------
  // コンテキスト使用量とコンパクション(M14。docs/plan/09-context-and-compaction.md)
  // ---------------------------------------------------------------------------

  /** 現在の表示パスをそのまま送った時のコンテキスト使用量の概算と上限 */
  async contextUsage(conversationId: string): Promise<ContextUsage> {
    const { conversations, messages, tools } = this.deps;
    const conv = conversations.get(conversationId);
    if (!conv) throw new Error('会話が見つかりません');
    const path = conv.activeLeafId ? messages.pathToRoot(conv.activeLeafId) : [];
    const { history, summary } = splitAtCompaction(path);
    const profile = conv.serverProfileId ? this.deps.profiles.get(conv.serverProfileId) : null;
    const model = profile ? resolveModel(conv, profile) : null;

    // 直近の usage(サーバーが数えた prompt + completion)を基準にし、それ以降のメッセージを推定で足す
    let measured: number | null = null;
    let measuredAt = -1;
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i]!;
      if (m.role === 'assistant' && m.usage?.promptTokens !== undefined) {
        measured = m.usage.promptTokens + (m.usage.completionTokens ?? 0);
        measuredAt = i;
        break;
      }
    }
    let estimated = 0;
    for (let i = measuredAt + 1; i < history.length; i++)
      estimated += this.estimateMessage(history[i]!);
    if (measured === null) {
      // usage が無い(まだ送っていない / サーバーが返さない)時は system・要約・ツール定義も足す
      estimated += estimateTokens(conv.systemPrompt ?? '') + estimateTokens(summary ?? '');
      if (profile && model) {
        try {
          const caps = await this.capabilitiesFor(profile, model);
          if (caps.tools)
            estimated += estimateTokens(
              JSON.stringify(
                tools.definitionsFor(caps, {
                  disabledCategories: conv.disabledCategories,
                  disabledTools: conv.disabledTools,
                }),
              ),
            );
        } catch {
          /* 推定なので無視 */
        }
      }
    }

    let limit: number | null = null;
    let limitSource: ContextUsage['limitSource'] = 'unknown';
    const paramLimit = conv.params.contextLength ?? profile?.defaultParams.contextLength;
    if (paramLimit) {
      limit = paramLimit;
      limitSource = 'params';
    } else if (profile && model) {
      const info = await this.describeModel(profile, model);
      if (info?.contextLength) {
        limit = info.contextLength;
        limitSource = 'server';
      }
    }
    return {
      used: (measured ?? 0) + estimated,
      measured,
      estimated,
      limit,
      limitSource,
      messagesInContext: history.filter((m) => m.kind !== 'note').length,
      compacted: summary !== null,
    };
  }

  /** メッセージ 1 件の概算トークン(送る形に近い見積もり。reasoning は送らないので数えない) */
  private estimateMessage(m: Message): number {
    let n = 4; // ロール等の枠
    for (const p of m.parts) {
      if (p.type === 'text') n += estimateTokens(p.text);
      else if (p.type === 'image') n += IMAGE_TOKENS;
      else if (p.type === 'video') n += p.sendMode === 'native' ? IMAGE_TOKENS * 8 : 80;
      else if (p.type === 'audio') n += 500;
      else if (p.type === 'file') {
        const a = this.deps.media?.store.get(p.attachmentId);
        n += a ? Math.ceil(Math.min(a.size, 30_000) / 3) : 100;
      }
    }
    if (m.toolCalls) for (const c of m.toolCalls) n += estimateTokens(c.name + c.args) + 8;
    return n;
  }

  /** 閾値を超えていれば要約ノードを作り、その id を返す。超えていなければ null */
  private async maybeAutoCompact(conversationId: string): Promise<string | null> {
    const threshold = Number(this.deps.getSetting?.('context.compactThreshold')) || 80;
    const usage = await this.contextUsage(conversationId);
    if (!usage.limit || (usage.used / usage.limit) * 100 < threshold) return null;
    const conv = this.deps.conversations.get(conversationId)!;
    const tempRunId = newId();
    const emit = (state: 'start' | 'done' | 'error') =>
      this.deps.emit({
        runId: tempRunId,
        conversationId,
        messageId: conv.activeLeafId ?? '',
        event: { type: 'compacting', state },
      });
    emit('start');
    try {
      const r = await this.compact(conversationId);
      emit('done');
      return r.messageId;
    } catch (e) {
      emit('error');
      throw new Error(`自動コンパクションに失敗しました: ${(e as Error).message}`);
    }
  }

  /**
   * 表示中のパスを要約して kind: compaction の節目ノードを末尾に追加する。
   * それ以前のメッセージは以後モデルに送らない(UI には残る)。圧縮前の位置から分岐すれば元の履歴で続けられる。
   */
  async compact(conversationId: string): Promise<{ messageId: string }> {
    const { conversations, messages } = this.deps;
    const conv = conversations.get(conversationId);
    if (!conv) throw new Error('会話が見つかりません');
    if (this.isRunning(conv.id)) throw new Error('この会話は応答生成中です');
    this.assertNoBackground(conv.id);
    const profile = this.requireProfile(conv.serverProfileId);
    const model = resolveModel(conv, profile);
    if (!model) throw new Error('モデルが選択されていません');
    if (!conv.activeLeafId) throw new Error('要約する会話がありません');
    const path = messages.pathToRoot(conv.activeLeafId);
    const { history, summary: previous } = splitAtCompaction(path);
    const meaningful = history.filter(
      (m) => m.kind === 'normal' && (m.role === 'user' || m.role === 'assistant'),
    );
    if (meaningful.length < 2) throw new Error('要約するほどの会話がまだありません');

    const usage = await this.contextUsage(conv.id);
    const charBudget = usage.limit ? Math.max(8_000, Math.floor(usage.limit * 0.6 * 2)) : 120_000;
    const transcript = renderTranscript(history, charBudget, this.deps.media?.store);
    const prompt =
      'You are compacting a long chat so it can continue with less context. Write a summary, in the same language the user writes in, that lets the assistant resume seamlessly. Include:\n' +
      "1. The user's goals and current request\n" +
      "2. Facts established, decisions made, and the user's preferences\n" +
      '3. Attachments and tool references that may still be needed: attachment_id / video_id / pdf_id / image ids, file paths, URLs (copy ids exactly)\n' +
      '4. Work in progress and what remains to be done\n' +
      '5. The most recent exchange in enough detail to continue naturally\n' +
      'Be concrete and compact (aim for under 1500 tokens). Output only the summary, as Markdown, no preamble.\n\n' +
      (previous
        ? `## Summary of even earlier conversation (already compacted)\n${previous}\n\n`
        : '') +
      `## Conversation to summarize\n${transcript}`;

    const controller = new AbortController();
    const runId = newId();
    let out = '';
    const done = (async () => {
      await this.ensureModelLoaded(profile, model, () => undefined, controller.signal);
      const capabilities = await this.capabilitiesFor(profile, model);
      for await (const ev of getAdapter(profile.kind).chat(
        profile,
        {
          model,
          messages: [{ role: 'user', text: prompt }],
          params: { temperature: 0.2, maxTokens: 4096, think: false },
          capabilities,
        },
        controller.signal,
      )) {
        if (ev.type === 'text-delta') out += ev.text;
        if (ev.type === 'error') throw new Error(ev.message);
      }
    })();
    this.runs.set(runId, {
      controller,
      conversationId: conv.id,
      done: done.catch(() => undefined),
    });
    try {
      await done;
    } finally {
      this.runs.delete(runId);
    }
    const text = out.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    if (!text) throw new Error('要約が空でした');
    const node = messages.create({
      conversationId: conv.id,
      parentId: conv.activeLeafId,
      role: 'user',
      kind: 'compaction',
      parts: [{ type: 'text', text }],
      model,
    });
    conversations.update(conv.id, { activeLeafId: node.id });
    return { messageId: node.id };
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
    const done = this.run(runId, conversationId, profile, assistant, controller.signal)
      .finally(() => {
        this.runs.delete(runId);
      })
      .then(() => this.maybeGenerateTitle(conversationId, profile, controller.signal))
      .catch(() => undefined);
    this.runs.set(runId, { controller, conversationId, done });
    return runId;
  }

  /**
   * 最初の往復が終わった会話に、モデルで短いタイトルを付ける。
   * 設定 titles.auto が false なら何もしない。失敗しても無視する。
   */
  private async maybeGenerateTitle(
    conversationId: string,
    profile: ServerProfile,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;
    if (this.deps.getSetting?.('titles.auto') === false) return;
    const { conversations, messages } = this.deps;
    const conv = conversations.get(conversationId);
    if (!conv?.activeLeafId) return;
    const path = messages.pathToRoot(conv.activeLeafId);
    const users = path.filter((m) => m.role === 'user' && m.kind === 'normal');
    const last = path.at(-1);
    if (users.length !== 1 || !last || last.role !== 'assistant' || last.finishReason !== 'stop')
      return;
    const userText = users[0]!.parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
    const assistantText = last.parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
    if (!assistantText.trim()) return;
    // ユーザーがタイトルを手で変えていたら触らない(送信時に付けた仮タイトルのままの時だけ)
    let firstAttachmentName = '';
    for (const p of users[0]!.parts) {
      if (p.type !== 'text' && p.type !== 'reasoning') {
        firstAttachmentName = p.name ?? '';
        break;
      }
    }
    if (conv.title !== makeTitle(userText || firstAttachmentName)) return;
    const model = resolveModel(conv, profile);
    if (!model) return;
    const capabilities = await this.capabilitiesFor(profile, model);
    const prompt =
      'Give this conversation a short title in the same language as the user, at most 20 characters, no quotes, no trailing punctuation. Output only the title.\n\n' +
      `User: ${[...userText].slice(0, 600).join('')}\n\nAssistant: ${[...assistantText].slice(0, 600).join('')}`;
    let out = '';
    try {
      for await (const ev of getAdapter(profile.kind).chat(
        profile,
        {
          model,
          messages: [{ role: 'user', text: prompt }],
          params: { temperature: 0.2, maxTokens: 48, think: false },
          capabilities,
        },
        signal,
      )) {
        if (ev.type === 'text-delta') out += ev.text;
        if (ev.type === 'error') return;
      }
    } catch {
      return;
    }
    const title = out
      .replace(/<think>[\s\S]*?<\/think>/g, '')
      .split(/\r?\n/)
      .map((s) => cleanTitle(s))
      .find((s) => s.length > 0);
    if (!title) return;
    const chars = [...title];
    const trimmed = chars.length > 30 ? chars.slice(0, 30).join('') + '…' : title;
    const latest = conversations.get(conversationId);
    if (latest && latest.title === conv.title)
      conversations.update(conversationId, { title: trimmed }, { touch: false });
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
      await this.ensureModelLoaded(profile, model, emit, signal);
      const capabilities = await this.capabilitiesFor(profile, model);
      const toolDefs = capabilities.tools
        ? tools.definitionsFor(capabilities, {
            disabledCategories: conv.disabledCategories,
            disabledTools: conv.disabledTools,
          })
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
        let detachedAny = false;
        for (const call of outcome.toolCalls) {
          const { lastId, detached } = await this.executeToolCall(call, {
            runId,
            conversationId,
            parentId,
            signal,
            counters,
            emit,
          });
          parentId = lastId;
          if (detached) detachedAny = true;
        }
        if (detachedAny) {
          // バックグラウンドタスクの完了を待つ。続きは finishBackground が再開する(M16)
          conversations.update(conversationId, { activeLeafId: parentId });
          emit({ type: 'path-changed' });
          return;
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
      toolGuide:
        this.deps.getSetting?.('tools.systemGuide') === false
          ? null
          : buildToolGuide(toolDefs, this.deps.getSetting ?? (() => null)),
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
  ): Promise<{ lastId: string; result: ToolResult; detached?: boolean }> {
    const { messages, tools } = this.deps;
    const startedAt = Date.now();

    // 承認
    const policy = tools.policyFor(call.name);
    const parsed = parseToolArgs(call.args);
    // ツール側が「この引数なら必ず承認」と言うもの(権限を宣言したコード実行など)は
    // ポリシー auto や「この会話では常に許可」でも確認する
    const forced =
      !parsed.error &&
      policy !== 'deny' &&
      (tools.get(call.name)?.requiresApproval?.(parsed.args) ?? false);
    let approval: ToolMeta['approval'] = 'auto';
    let denyReason: string | undefined;
    if (policy === 'deny') {
      approval = 'denied';
    } else if (
      forced ||
      (policy === 'ask' && !this.conversationAllow.get(ctx.conversationId)?.has(call.name))
    ) {
      ctx.emit({ type: 'tool-approval-request', call });
      const answer = await this.awaitApproval(ctx.runId, call.id, ctx.signal);
      const decision = answer.decision;
      if (answer.reason) denyReason = answer.reason;
      if (decision === 'deny') approval = 'denied';
      else if (decision === 'allow-conversation') {
        approval = 'approved-conversation';
        // 強制承認のツールは会話単位の常時許可には入れない(次回も権限を確認する)
        if (!forced) {
          let set = this.conversationAllow.get(ctx.conversationId);
          if (!set) this.conversationAllow.set(ctx.conversationId, (set = new Set()));
          set.add(call.name);
        }
      } else approval = 'approved';
    }

    let result: ToolResult;
    ctx.emit({ type: 'tool-start', call });
    if (approval === 'denied') {
      result = {
        text:
          policy === 'deny'
            ? 'error: このツールは設定で無効化されています'
            : denyReason
              ? `error: ユーザーが実行を拒否しました。理由: ${denyReason}\n(理由に沿って修正するか、必要なら意図を説明してから再試行してください。ユーザーへの返答は続けてください)`
              : 'error: ユーザーが実行を拒否しました(ユーザーへの返答は続けてください)',
        isError: true,
      };
    } else {
      if (parsed.error) result = { text: `error: ${parsed.error}`, isError: true };
      else {
        // ツールには専用の AbortController を渡す。run の中断は切り離すまでは伝播し、切り離した後は独立させる
        const controller = new AbortController();
        const relay = () => controller.abort(ctx.signal.reason);
        ctx.signal.addEventListener('abort', relay, { once: true });
        const exec = tools.execute(call.name, parsed.args, {
          conversationId: ctx.conversationId,
          runId: ctx.runId,
          signal: controller.signal,
          counters: ctx.counters,
          getSetting: this.deps.getSetting ?? (() => null),
        });
        const immediate = tools.get(call.name)?.background?.(parsed.args) ?? false;
        const settingMs = Number(this.deps.getSetting?.('tools.backgroundAfterMs'));
        const afterMs = immediate ? 0 : Number.isFinite(settingMs) ? settingMs : 30_000;
        const raced =
          immediate || afterMs > 0
            ? await raceDetach(exec, afterMs, ctx.signal)
            : { kind: 'result' as const, result: await exec };
        if (raced.kind === 'detach') {
          ctx.signal.removeEventListener('abort', relay);
          const meta: ToolMeta = {
            name: call.name,
            args: call.args,
            durationMs: 0,
            isError: false,
            approval,
            background: { status: 'running', startedAt },
          };
          const toolMsg = messages.create({
            conversationId: ctx.conversationId,
            parentId: ctx.parentId,
            role: 'tool',
            parts: [{ type: 'text', text: '(バックグラウンドで実行中)' }],
            toolCallId: call.id,
            toolMeta: meta,
          });
          const key = `${ctx.conversationId}\u0000${call.id}`;
          this.background.set(key, {
            conversationId: ctx.conversationId,
            callId: call.id,
            messageId: toolMsg.id,
            name: call.name,
            startedAt,
            runId: ctx.runId,
            controller,
          });
          ctx.emit({
            type: 'tool-background',
            state: 'start',
            callId: call.id,
            messageId: toolMsg.id,
          });
          void exec.then(
            (r) => this.finishBackground(key, r),
            (err: unknown) =>
              this.finishBackground(key, {
                text: `error: ${(err as Error).message ?? String(err)}`,
                isError: true,
              }),
          );
          return { lastId: toolMsg.id, result: { text: '', isError: false }, detached: true };
        }
        ctx.signal.removeEventListener('abort', relay);
        result = raced.result;
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
      ...(denyReason ? { denyReason } : {}),
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
    const mediaMsg = this.deliverMedia(ctx.conversationId, toolMsg.id, call.name, result);
    return { lastId: mediaMsg ? mediaMsg.id : toolMsg.id, result };
  }

  private awaitApproval(
    runId: string,
    callId: string,
    signal: AbortSignal,
  ): Promise<ApprovalAnswer> {
    const key = `${runId}\u0000${callId}`;
    return new Promise<ApprovalAnswer>((resolve, reject) => {
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

/** モデルが付けがちな引用符・句点・「タイトル:」の前置きを落とす */
function cleanTitle(raw: string): string {
  let s = raw
    .trim()
    .replace(/^(タイトル|title)\s*[:：]\s*/i, '')
    .replace(/[*_`#>]+/g, ''); // Markdown の装飾は落とす
  for (let i = 0; i < 3; i++) {
    s = s
      .replace(/[\s。.!！?？、,]+$/, '')
      .replace(/^["'「『“‘]+|["'」』”’]+$/g, '')
      .trim();
  }
  return s;
}

function makeTitle(text: string): string {
  const line = text.trim().split(/\r?\n/)[0] ?? '';
  const chars = [...line];
  return chars.length > 40 ? chars.slice(0, 40).join('') + '…' : line;
}

/** 要約用に会話をテキスト化する(添付は id と名前、ツール結果は先頭だけ)。文字数上限を超えたら古い方を落とす */
export function renderTranscript(
  history: Message[],
  charBudget: number,
  store?: Pick<MediaStore, 'get'>,
): string {
  const blocks: string[] = [];
  for (const m of history) {
    if (m.kind === 'note') continue;
    const lines: string[] = [];
    for (const p of m.parts) {
      if (p.type === 'text') lines.push(p.text);
      else if (p.type === 'reasoning') continue;
      else {
        const a = store?.get(p.attachmentId);
        const name = p.name ?? a?.originalName ?? p.attachmentId;
        const idLabel =
          p.type === 'video'
            ? 'video_id'
            : a?.mime === 'application/pdf'
              ? 'pdf_id'
              : 'attachment_id';
        lines.push(`[attached ${p.type}: ${idLabel}=${p.attachmentId}, name="${name}"]`);
      }
    }
    if (m.toolCalls)
      for (const c of m.toolCalls) lines.push(`[tool call ${c.name}(${c.args.slice(0, 300)})]`);
    let body = lines.join('\n').trim();
    if (m.role === 'tool') {
      const name = (m.toolMeta as { name?: string } | null)?.name ?? 'tool';
      body = `[tool result ${name}] ${body.slice(0, 500)}${body.length > 500 ? ' …' : ''}`;
    }
    if (!body) continue;
    const role =
      m.role === 'tool'
        ? 'Tool'
        : m.kind === 'tool-media'
          ? 'Tool media'
          : m.role === 'user'
            ? 'User'
            : 'Assistant';
    blocks.push(`### ${role}\n${body}`);
  }
  let total = blocks.reduce((n, b) => n + b.length + 2, 0);
  let dropped = 0;
  while (blocks.length > 2 && total > charBudget) {
    total -= blocks.shift()!.length + 2;
    dropped++;
  }
  const head = dropped > 0 ? `[${dropped} earlier messages omitted for length]\n\n` : '';
  return head + blocks.join('\n\n');
}

/** ツールの Promise と切り離しタイマーを競走させる。run が中断されたらツール側の拒否がそのまま伝わる */
async function raceDetach(
  exec: Promise<ToolResult>,
  afterMs: number,
  signal: AbortSignal,
): Promise<{ kind: 'result'; result: ToolResult } | { kind: 'detach' }> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const detach = new Promise<{ kind: 'detach' }>((resolve) => {
    timer = setTimeout(() => resolve({ kind: 'detach' }), Math.max(0, afterMs));
  });
  try {
    return await Promise.race([
      exec.then((result) => ({ kind: 'result' as const, result })),
      detach,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    void signal;
  }
}

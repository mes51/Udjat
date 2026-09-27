import { create } from 'zustand';
import type { ChatRunEvent, FinishReason, ToolCall, Usage } from '@shared/schemas';

/**
 * ストリーミング中の assistant メッセージの一時状態。
 * 確定後は DB(messages:path)が正になるので、done を受けたら短時間で破棄する。
 */
export interface StreamState {
  runId: string;
  conversationId: string;
  text: string;
  reasoning: string;
  status: 'streaming' | 'done' | 'error';
  finishReason: FinishReason | null;
  error: string | null;
  usage: Usage | null;
  startedAt: number;
}

export interface ToolActivity {
  call: ToolCall;
  status: 'running' | 'done';
  isError: boolean;
  durationMs: number | null;
}

export interface PendingApproval {
  runId: string;
  conversationId: string;
  messageId: string;
  call: ToolCall;
}

interface StreamStore {
  streams: Record<string, StreamState>;
  /** conversationId -> runId(実行中のみ) */
  running: Record<string, string>;
  /** assistant messageId -> 実行中/完了したツール呼び出し */
  toolActivity: Record<string, Record<string, ToolActivity>>;
  /** callId -> 承認待ち */
  approvals: Record<string, PendingApproval>;
  /** conversationId -> 送信前にロード中のモデル名(M10) */
  modelLoading: Record<string, string>;
  /** conversationId -> 送信前の自動コンパクション(要約)中か(M14) */
  compacting: Record<string, boolean>;
  begin: (handle: { runId: string; conversationId: string; assistantMessageId: string }) => void;
  apply: (ev: ChatRunEvent) => void;
  clear: (messageId: string) => void;
  resolveApproval: (callId: string) => void;
}

function emptyStream(runId: string, conversationId: string): StreamState {
  return {
    runId,
    conversationId,
    text: '',
    reasoning: '',
    status: 'streaming',
    finishReason: null,
    error: null,
    usage: null,
    startedAt: Date.now(),
  };
}

export const useStreamStore = create<StreamStore>((set) => ({
  streams: {},
  running: {},
  toolActivity: {},
  approvals: {},
  modelLoading: {},
  compacting: {},
  begin: ({ runId, conversationId, assistantMessageId }) =>
    set((s) => {
      // invoke の往復中にイベントが先に届いていたら、その状態を尊重する
      const existing = s.streams[assistantMessageId];
      if (existing && existing.runId === runId) {
        return { running: { ...s.running, [conversationId]: runId } };
      }
      return {
        streams: { ...s.streams, [assistantMessageId]: emptyStream(runId, conversationId) },
        running: { ...s.running, [conversationId]: runId },
      };
    }),
  apply: (ev) =>
    set((s) => {
      const e = ev.event;
      const running = { ...s.running };
      if (e.type === 'run-end') {
        delete running[ev.conversationId];
        const modelLoading = { ...s.modelLoading };
        delete modelLoading[ev.conversationId];
        return { running, modelLoading };
      }
      if (e.type === 'tool-background') {
        // タスクの開始・終了は run の状態に触れない(終了は run が終わった後に届く)
        return {};
      }
      if (e.type === 'compacting') {
        // 要約は run の外で走る(失敗しても run は始まらない)ので running には触れない
        const compacting = { ...s.compacting };
        if (e.state === 'start') compacting[ev.conversationId] = true;
        else delete compacting[ev.conversationId];
        return { compacting };
      }
      running[ev.conversationId] = ev.runId;

      if (e.type === 'path-changed') return { running };
      if (e.type === 'model-load') {
        const modelLoading = { ...s.modelLoading };
        if (e.state === 'loading') modelLoading[ev.conversationId] = e.model;
        else delete modelLoading[ev.conversationId];
        return { running, modelLoading };
      }

      if (e.type === 'tool-approval-request') {
        return {
          running,
          approvals: {
            ...s.approvals,
            [e.call.id]: {
              runId: ev.runId,
              conversationId: ev.conversationId,
              messageId: ev.messageId,
              call: e.call,
            },
          },
        };
      }
      if (e.type === 'tool-start' || e.type === 'tool-end') {
        const forMsg = { ...(s.toolActivity[ev.messageId] ?? {}) };
        if (e.type === 'tool-start') {
          forMsg[e.call.id] = { call: e.call, status: 'running', isError: false, durationMs: null };
        } else {
          const cur = forMsg[e.callId];
          if (cur)
            forMsg[e.callId] = {
              ...cur,
              status: 'done',
              isError: e.isError,
              durationMs: e.durationMs,
            };
        }
        const approvals = { ...s.approvals };
        if (e.type === 'tool-start') delete approvals[e.call.id];
        return { running, toolActivity: { ...s.toolActivity, [ev.messageId]: forMsg }, approvals };
      }

      const cur = s.streams[ev.messageId] ?? emptyStream(ev.runId, ev.conversationId);
      const next: StreamState = { ...cur };
      if (e.type === 'text-delta') next.text += e.text;
      else if (e.type === 'reasoning-delta') next.reasoning += e.text;
      else if (e.type === 'usage') next.usage = e.usage;
      else if (e.type === 'error') {
        next.error = e.message;
        next.status = 'error';
      } else if (e.type === 'done') {
        next.finishReason = e.finishReason;
        if (next.status !== 'error') next.status = e.finishReason === 'error' ? 'error' : 'done';
      }
      return { streams: { ...s.streams, [ev.messageId]: next }, running };
    }),
  clear: (messageId) =>
    set((s) => {
      const streams = { ...s.streams };
      delete streams[messageId];
      const toolActivity = { ...s.toolActivity };
      delete toolActivity[messageId];
      return { streams, toolActivity };
    }),
  resolveApproval: (callId) =>
    set((s) => {
      const approvals = { ...s.approvals };
      delete approvals[callId];
      return { approvals };
    }),
}));

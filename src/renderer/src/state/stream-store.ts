import { create } from 'zustand';
import type { ChatRunEvent, FinishReason, Usage } from '@shared/schemas';

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

interface StreamStore {
  streams: Record<string, StreamState>;
  /** conversationId -> runId(実行中のみ) */
  running: Record<string, string>;
  begin: (handle: { runId: string; conversationId: string; assistantMessageId: string }) => void;
  apply: (ev: ChatRunEvent) => void;
  clear: (messageId: string) => void;
}

export const useStreamStore = create<StreamStore>((set) => ({
  streams: {},
  running: {},
  begin: ({ runId, conversationId, assistantMessageId }) =>
    set((s) => {
      // invoke の往復中にイベントが先に届いていたら、その状態を尊重する
      const existing = s.streams[assistantMessageId];
      if (existing && existing.runId === runId) {
        return existing.status === 'streaming'
          ? { running: { ...s.running, [conversationId]: runId } }
          : {};
      }
      return {
        streams: {
          ...s.streams,
          [assistantMessageId]: {
            runId,
            conversationId,
            text: '',
            reasoning: '',
            status: 'streaming',
            finishReason: null,
            error: null,
            usage: null,
            startedAt: Date.now(),
          },
        },
        running: { ...s.running, [conversationId]: runId },
      };
    }),
  apply: (ev) =>
    set((s) => {
      const cur = s.streams[ev.messageId] ?? {
        runId: ev.runId,
        conversationId: ev.conversationId,
        text: '',
        reasoning: '',
        status: 'streaming' as const,
        finishReason: null,
        error: null,
        usage: null,
        startedAt: Date.now(),
      };
      const next: StreamState = { ...cur };
      const e = ev.event;
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
      const running = { ...s.running };
      if (e.type === 'done') delete running[ev.conversationId];
      else running[ev.conversationId] = ev.runId;
      return { streams: { ...s.streams, [ev.messageId]: next }, running };
    }),
  clear: (messageId) =>
    set((s) => {
      const streams = { ...s.streams };
      delete streams[messageId];
      return { streams };
    }),
}));

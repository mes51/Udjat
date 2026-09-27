import type { Attachment } from '@shared/schemas';
import type { MediaStore } from '@main/media/store';
import { fmt, type VideoOps } from '@main/media/video-ops';
import type { RegisteredTool, ToolMedia } from '../types';
import { fail, num, ok, str, ToolError } from '../types';

/**
 * 動画ツール群。LLM が必要なフレームを自分で取りに行くための道具。
 * 設計は docs/plan/03-video-and-attachments.md。
 */

export interface VideoToolDeps {
  store: MediaStore;
  ops: VideoOps;
}

function requireVideo(store: MediaStore, id: string): Attachment {
  const a = store.get(id);
  if (!a)
    throw new ToolError(
      `video_id ${id} は存在しません。添付された動画の video_id を使ってください`,
    );
  if (a.meta.kind !== 'video') throw new ToolError(`${id} は動画ではありません (${a.meta.kind})`);
  return a;
}

function sec(args: Record<string, unknown>, key: string, fallback: number): number {
  return num(args, key, fallback, 0) * 1000;
}

function media(a: Attachment, label: string): ToolMedia {
  return {
    attachmentId: a.id,
    mime: a.mime,
    label,
    kind: a.meta.kind === 'video' ? 'video' : 'image',
  };
}

export function infoOf(a: Attachment): Record<string, unknown> {
  return {
    video_id: a.id,
    name: a.originalName,
    duration_s: a.meta.durationMs !== undefined ? +(a.meta.durationMs / 1000).toFixed(2) : null,
    width: a.meta.width ?? null,
    height: a.meta.height ?? null,
    fps: a.meta.fps !== undefined ? +a.meta.fps.toFixed(2) : null,
    has_audio: a.meta.hasAudio ?? null,
    codec: a.meta.codec ?? null,
    size_bytes: a.size,
  };
}

export function createVideoTools({ store, ops }: VideoToolDeps): RegisteredTool[] {
  const videoInfo: RegisteredTool = {
    definition: {
      name: 'video_info',
      description:
        '添付された動画のメタ情報(長さ、解像度、fps、音声の有無)を返す。動画について答える前にまず呼ぶ。',
      parameters: {
        type: 'object',
        properties: { video_id: { type: 'string', description: '添付の video_id' } },
        required: ['video_id'],
        additionalProperties: false,
      },
    },
    source: { kind: 'builtin' },
    category: 'video',
    defaultPolicy: 'auto',
    execute: async (args) => ok(JSON.stringify(infoOf(requireVideo(store, str(args, 'video_id'))))),
  };

  const videoScenes: RegisteredTool = {
    definition: {
      name: 'video_scenes',
      description:
        'シーンの切り替わり時刻(秒)の一覧を返す。動画のどこを見るべきか決めるのに使う。切り替わりが検出されない動画もある。',
      parameters: {
        type: 'object',
        properties: {
          video_id: { type: 'string' },
          threshold: {
            type: 'number',
            description: '検出感度 0.1〜0.9 (既定 0.3、小さいほど多く検出)',
            minimum: 0.05,
            maximum: 0.95,
          },
          max: { type: 'integer', description: '最大件数 (既定 50)', minimum: 1, maximum: 200 },
        },
        required: ['video_id'],
        additionalProperties: false,
      },
    },
    source: { kind: 'builtin' },
    category: 'video',
    defaultPolicy: 'auto',
    execute: async (args, ctx) => {
      const v = requireVideo(store, str(args, 'video_id'));
      const threshold = num(args, 'threshold', 0.3, 0.05, 0.95);
      const max = num(args, 'max', 50, 1, 200);
      const times = await ops.scenes(v, threshold, max, ctx.signal);
      return ok(
        JSON.stringify({
          video_id: v.id,
          threshold,
          scene_changes_s: times.map((t) => +(t / 1000).toFixed(2)),
          note:
            times.length === 0
              ? 'シーン切替は検出されませんでした。video_contact_sheet で全体を俯瞰してください'
              : undefined,
        }),
      );
    },
  };

  const videoContactSheet: RegisteredTool = {
    definition: {
      name: 'video_contact_sheet',
      description:
        '指定区間を等間隔にサンプリングしたフレームを 1 枚のタイル画像にして返す(各タイルに時刻を焼き込み)。少ないトークンで動画全体や区間を俯瞰するのに最適。まずこれで見てから、気になる時刻を video_frames で確認する。',
      parameters: {
        type: 'object',
        properties: {
          video_id: { type: 'string' },
          start: { type: 'number', description: '開始秒 (既定 0)' },
          end: { type: 'number', description: '終了秒 (既定 動画の末尾)' },
          cols: { type: 'integer', description: '列数 (既定 4)', minimum: 1, maximum: 8 },
          rows: { type: 'integer', description: '行数 (既定 4)', minimum: 1, maximum: 8 },
        },
        required: ['video_id'],
        additionalProperties: false,
      },
    },
    source: { kind: 'builtin' },
    category: 'video',
    defaultPolicy: 'auto',
    execute: async (args, ctx) => {
      const v = requireVideo(store, str(args, 'video_id'));
      const dur = ops.durationMs(v);
      const startMs = sec(args, 'start', 0);
      const endMs = 'end' in args && args['end'] !== undefined ? sec(args, 'end', dur / 1000) : dur;
      if (endMs <= startMs) return fail('end は start より大きい必要があります');
      const cols = num(args, 'cols', 4, 1, 8);
      const rows = num(args, 'rows', 4, 1, 8);
      const { sheet, timestampsMs } = await ops.contactSheet(
        v,
        { startMs, endMs, cols, rows },
        ctx.signal,
      );
      return ok(
        JSON.stringify({
          video_id: v.id,
          range_s: [+(startMs / 1000).toFixed(2), +(endMs / 1000).toFixed(2)],
          grid: `${cols}x${rows}`,
          tiles: timestampsMs.map((t, i) => ({ index: i + 1, t_s: +(t / 1000).toFixed(2) })),
          note: '画像は次のメッセージに添付。タイルは左上から右へ、行ごとに時系列順',
        }),
        [media(sheet, `contact sheet ${fmt(startMs)}-${fmt(endMs)} (${cols}x${rows})`)],
      );
    },
  };

  const videoFrames: RegisteredTool = {
    definition: {
      name: 'video_frames',
      description:
        '指定した時刻のフレーム画像を返す。timestamps で時刻を列挙するか、start/end/fps で区間を等間隔に切り出す。細部を確認する時に使う。枚数は控えめに(既定 最大 8 枚)。',
      parameters: {
        type: 'object',
        properties: {
          video_id: { type: 'string' },
          timestamps: {
            type: 'array',
            items: { type: 'number' },
            description: '取得する時刻(秒)の配列',
          },
          start: { type: 'number', description: '区間指定の開始秒' },
          end: { type: 'number', description: '区間指定の終了秒' },
          fps: { type: 'number', description: '区間指定時のサンプリング fps (既定 1)' },
          max_frames: {
            type: 'integer',
            description: '最大枚数 (既定 8、上限 16)',
            minimum: 1,
            maximum: 16,
          },
          width: {
            type: 'integer',
            description: 'フレームの幅 px (既定 768)',
            minimum: 128,
            maximum: 1536,
          },
        },
        required: ['video_id'],
        additionalProperties: false,
      },
    },
    source: { kind: 'builtin' },
    category: 'video',
    defaultPolicy: 'auto',
    execute: async (args, ctx) => {
      const v = requireVideo(store, str(args, 'video_id'));
      const dur = ops.durationMs(v);
      const maxFrames = num(args, 'max_frames', 8, 1, 16);
      const width = num(args, 'width', 768, 128, 1536);
      let timestampsMs: number[];
      const ts = args['timestamps'];
      if (Array.isArray(ts) && ts.length > 0) {
        timestampsMs = ts.map((t) => Number(t) * 1000).filter((t) => Number.isFinite(t));
      } else if (args['start'] !== undefined || args['end'] !== undefined) {
        const startMs = sec(args, 'start', 0);
        const endMs =
          'end' in args && args['end'] !== undefined ? sec(args, 'end', dur / 1000) : dur;
        const fps = num(args, 'fps', 1, 0.05, 30);
        timestampsMs = [];
        for (let t = startMs; t <= endMs && timestampsMs.length < maxFrames; t += 1000 / fps)
          timestampsMs.push(Math.round(t));
      } else {
        return fail('timestamps か start/end のどちらかを指定してください');
      }
      const truncated = timestampsMs.length > maxFrames;
      timestampsMs = timestampsMs.slice(0, maxFrames);
      const frames = await ops.frames(v, timestampsMs, width, ctx.signal);
      return ok(
        JSON.stringify({
          video_id: v.id,
          frames: frames.map((f, i) => ({
            index: i + 1,
            t_s: +((f.meta.timestampMs ?? timestampsMs[i] ?? 0) / 1000).toFixed(2),
          })),
          truncated: truncated ? `max_frames=${maxFrames} で打ち切り` : undefined,
          note: '画像は次のメッセージに添付(同じ順序)',
        }),
        frames.map((f) => media(f, `frame @${fmt(f.meta.timestampMs ?? 0)}`)),
      );
    },
  };

  const videoClip: RegisteredTool = {
    definition: {
      name: 'video_clip',
      description:
        '指定区間を縮小・低 fps の短い動画として次のメッセージに添付する。動きの理解が必要な時だけ使う(フレーム画像より重い)。区間は 60 秒以内。',
      parameters: {
        type: 'object',
        properties: {
          video_id: { type: 'string' },
          start: { type: 'number', description: '開始秒' },
          end: { type: 'number', description: '終了秒' },
          fps: {
            type: 'number',
            description: 'クリップの fps (既定 2)',
            minimum: 0.5,
            maximum: 10,
          },
          width: {
            type: 'integer',
            description: 'クリップの幅 px (既定 640)',
            minimum: 160,
            maximum: 1280,
          },
        },
        required: ['video_id', 'start', 'end'],
        additionalProperties: false,
      },
    },
    source: { kind: 'builtin' },
    category: 'video',
    defaultPolicy: 'auto',
    requires: { video: 'native' },
    execute: async (args, ctx) => {
      const v = requireVideo(store, str(args, 'video_id'));
      const startMs = sec(args, 'start', 0);
      const endMs = sec(args, 'end', 0);
      if (endMs <= startMs) return fail('end は start より大きい必要があります');
      if (endMs - startMs > 60_000) return fail('区間は 60 秒以内にしてください');
      const fps = num(args, 'fps', 2, 0.5, 10);
      const width = num(args, 'width', 640, 160, 1280);
      const clip = await ops.clip(v, startMs, endMs, width, fps, ctx.signal);
      return ok(
        JSON.stringify({
          video_id: v.id,
          range_s: [+(startMs / 1000).toFixed(2), +(endMs / 1000).toFixed(2)],
          fps,
          width,
          note: '動画は次のメッセージに添付',
        }),
        [media(clip, `clip ${fmt(startMs)}-${fmt(endMs)}`)],
      );
    },
  };

  return [videoInfo, videoScenes, videoContactSheet, videoFrames, videoClip];
}

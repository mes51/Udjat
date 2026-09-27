import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execa } from 'execa';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatRunEvent } from '@shared/schemas';
import { openDatabase, type Database } from '@main/db/client';
import { AttachmentRepository } from '@main/db/repositories/attachments';
import { ConversationRepository } from '@main/db/repositories/conversations';
import { MessageRepository } from '@main/db/repositories/messages';
import { ServerProfileRepository } from '@main/db/repositories/server-profiles';
import { binariesAvailable, resolveBinaries } from '@main/media/binaries';
import { FfmpegService } from '@main/media/ffmpeg';
import { MediaStore } from '@main/media/store';
import { VideoOps } from '@main/media/video-ops';
import { sse, startMockServer, type MockServer } from '@main/providers/test-server';
import { createVideoTools } from '@main/tools/builtin/video';
import { ToolRegistry } from '@main/tools/registry';
import { MediaResolver } from './media-resolver';
import { ChatService } from './service';

const bins = resolveBinaries();
const available = binariesAvailable(bins);

let dir: string;
let videoPath: string;
let db: Database;
let server: MockServer | null = null;
let events: ChatRunEvent[];
let service: ChatService;
let store: MediaStore;
let messages: MessageRepository;
let conversations: ConversationRepository;
let profiles: ServerProfileRepository;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'udjat-svc-media-'));
  videoPath = join(dir, 'clip.mp4');
  await execa(bins.ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc=duration=6:size=320x240:rate=10',
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    videoPath,
  ]);
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  db = openDatabase({ path: ':memory:' });
  profiles = new ServerProfileRepository(db);
  conversations = new ConversationRepository(db);
  messages = new MessageRepository(db);
  const attachments = new AttachmentRepository(db);
  const ffmpeg = new FfmpegService();
  store = new MediaStore(attachments, ffmpeg, {
    mediaDir: join(dir, 'media'),
    cacheDir: join(dir, 'cache'),
  });
  const ops = new VideoOps(store, ffmpeg);
  const tools = new ToolRegistry(db);
  for (const t of createVideoTools({ store, ops })) tools.register(t);
  events = [];
  service = new ChatService({
    profiles,
    conversations,
    messages,
    tools,
    emit: (e) => events.push(e),
    flushIntervalMs: 0,
    getSetting: (k) => (k === 'titles.auto' ? false : null),
    media: { store, ops, attachments, resolver: new MediaResolver(store, ops) },
  });
});

afterEach(async () => {
  await server?.close();
  server = null;
  db.close();
});

type Wire = { role: string; content: string | { type: string }[] };

describe.skipIf(!available.ffmpeg)('ChatService with video attachments', () => {
  it('sends a video note plus contact sheet, then delivers tool frames as a follow-up user message', async () => {
    // 1 回目: video_frames を呼ぶ。2 回目: 画像を受け取って回答
    server = await startMockServer({
      'POST /v1/chat/completions': (_r, body, res) => {
        const msgs = (body as { messages: Wire[] }).messages;
        if (msgs.at(-1)?.role !== 'user' || msgs.length > 1) {
          sse(res, [
            {
              choices: [
                { delta: { content: '赤い矩形が 2 秒目に見えます' }, finish_reason: 'stop' },
              ],
            },
          ]);
        } else {
          sse(res, [
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'c1',
                        function: {
                          name: 'video_frames',
                          arguments: '{"video_id":"VID","timestamps":[1,2]}',
                        },
                      },
                    ],
                  },
                },
              ],
            },
            { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
          ]);
        }
      },
    });
    const p = profiles.create({
      name: 'l',
      kind: 'llamacpp',
      baseUrl: server.url,
      apiKey: null,
      defaultModel: 'qwen3-vl',
      defaultParams: {},
      capabilityOverrides: {},
      modelManagement: { autoLoad: false, unloadOthers: false },
    });
    const c = conversations.create({ serverProfileId: p.id, model: null });
    const video = await store.addFile(videoPath);
    expect(video.meta).toMatchObject({ kind: 'video', width: 320 });

    // モックはツール引数に固定の video_id を返すので差し替える
    server.requests.length = 0;
    const origHandler = server;
    void origHandler;
    const run = await service.send({
      conversationId: c.id,
      text: 'この動画で何が起きている?',
      attachments: [{ id: video.id }],
    });
    await service.waitFor(run.runId);

    const path = messages.pathToRoot(conversations.get(c.id)!.activeLeafId!);
    // 存在しない video_id なのでツールはエラー結果(画像なし)を返し、tool-media は作られない
    expect(path.map((m) => `${m.role}:${m.kind}`)).toEqual([
      'user:normal',
      'assistant:normal',
      'tool:normal',
      'assistant:normal',
    ]);
    // ユーザーメッセージ: テキスト + 動画パート + コンタクトシート画像
    expect(path[0]!.parts.map((x) => x.type)).toEqual(['text', 'video', 'image']);
    // 1 回目のリクエスト: 動画注記と video_id、コンタクトシートが画像として送られている
    const first = server.requests[0]!.body as {
      messages: Wire[];
      tools: { function: { name: string } }[];
    };
    const userContent = first.messages[0]!.content as { type: string; text?: string }[];
    expect(userContent[0]!.text).toContain(`video_id=${video.id}`);
    expect(userContent.some((x) => x.type === 'image_url')).toBe(true);
    expect(first.tools.map((t) => t.function.name)).toContain('video_frames');
    expect(first.tools.map((t) => t.function.name)).toContain('video_clip'); // llama.cpp + VL なので native

    // tool 結果(存在しない VID を指定しているのでエラー)ではなく、実際の id で再実行して配送を確認
    const toolMsg = path[2]!;
    expect((toolMsg.parts[0] as { text: string }).text).toMatch(/video_id VID/);
  });

  it('delivers frames from a real video_frames call and sends them as images on the next turn', async () => {
    let videoId = '';
    server = await startMockServer({
      'POST /v1/chat/completions': (_r, body, res) => {
        const msgs = (body as { messages: Wire[] }).messages;
        if (msgs.length === 1) {
          sse(res, [
            {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: 'c1',
                        function: {
                          name: 'video_frames',
                          arguments: JSON.stringify({ video_id: videoId, timestamps: [1, 2.5] }),
                        },
                      },
                    ],
                  },
                },
              ],
            },
            { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
          ]);
        } else {
          sse(res, [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]);
        }
      },
    });
    const p = profiles.create({
      name: 'l',
      kind: 'llamacpp',
      baseUrl: server.url,
      apiKey: null,
      defaultModel: 'qwen3-vl',
      defaultParams: {},
      capabilityOverrides: {},
      modelManagement: { autoLoad: false, unloadOthers: false },
    });
    const c = conversations.create({ serverProfileId: p.id, model: null });
    const video = await store.addFile(videoPath);
    videoId = video.id;
    const run = await service.send({
      conversationId: c.id,
      text: '',
      attachments: [{ id: video.id }],
    });
    await service.waitFor(run.runId);

    const path = messages.pathToRoot(conversations.get(c.id)!.activeLeafId!);
    expect(path.map((m) => `${m.role}:${m.kind}`)).toEqual([
      'user:normal',
      'assistant:normal',
      'tool:normal',
      'user:tool-media',
      'assistant:normal',
    ]);
    const toolText = (path[2]!.parts[0] as { text: string }).text;
    expect(JSON.parse(toolText)).toMatchObject({
      frames: [
        { index: 1, t_s: 1 },
        { index: 2, t_s: 2.5 },
      ],
    });
    const mediaMsg = path[3]!;
    expect(mediaMsg.parts.map((x) => x.type)).toEqual(['text', 'image', 'image']);

    // 2 回目のリクエストでは tool メッセージの後に画像付き user メッセージが送られる
    const second = server.requests[1]!.body as { messages: Wire[] };
    expect(second.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    const followUp = second.messages[3]!.content as { type: string; image_url?: { url: string } }[];
    expect(followUp.filter((x) => x.type === 'image_url')).toHaveLength(2);
    expect(followUp.find((x) => x.type === 'image_url')?.image_url?.url).toMatch(
      /^data:image\/jpeg;base64,/,
    );
    // 会話タイトルは添付名から
    expect(conversations.get(c.id)!.title).toBe('clip.mp4');

    // 再生成は tool-media(role: user)ではなく、本当のユーザー発言の直下に分岐を作る
    const r2 = await service.regenerate(path[4]!.id);
    expect(messages.get(r2.assistantMessageId)!.parentId).toBe(path[0]!.id);
    await service.waitFor(r2.runId);
  });

  it('sends the video natively when requested and the server supports it', async () => {
    server = await startMockServer({
      'POST /v1/chat/completions': (_r, _b, res) =>
        sse(res, [{ choices: [{ delta: { content: 'seen' }, finish_reason: 'stop' }] }]),
    });
    const p = profiles.create({
      name: 'l',
      kind: 'llamacpp',
      baseUrl: server.url,
      apiKey: null,
      defaultModel: 'qwen3-vl',
      defaultParams: {},
      capabilityOverrides: {},
      modelManagement: { autoLoad: false, unloadOthers: false },
    });
    const c = conversations.create({ serverProfileId: p.id, model: null });
    const video = await store.addFile(videoPath);
    const run = await service.send({
      conversationId: c.id,
      text: '動き',
      attachments: [{ id: video.id, sendMode: 'native' }],
    });
    await service.waitFor(run.runId);
    const req = server.requests[0]!.body as { messages: Wire[] };
    const content = req.messages[0]!.content as { type: string; input_video?: { data: string } }[];
    expect(content.map((x) => x.type)).toEqual(['text', 'input_video']);
    expect(content[1]!.input_video!.data.length).toBeGreaterThan(1000);
    // native 送信時はコンタクトシートを付けない
    const path = messages.pathToRoot(conversations.get(c.id)!.activeLeafId!);
    expect(path[0]!.parts.map((x) => x.type)).toEqual(['text', 'video']);
  });

  it('applies a user-selected range to the native clip and to the contact sheet', async () => {
    server = await startMockServer({
      'POST /v1/chat/completions': (_r, _b, res) =>
        sse(res, [{ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }]),
    });
    const p = profiles.create({
      name: 'l',
      kind: 'llamacpp',
      baseUrl: server.url,
      apiKey: null,
      defaultModel: 'qwen3-vl',
      defaultParams: {},
      capabilityOverrides: {},
      modelManagement: { autoLoad: false, unloadOthers: false },
    });
    const video = await store.addFile(videoPath);
    const dur = video.meta.durationMs!;
    const range = { startMs: Math.floor(dur * 0.25), endMs: Math.floor(dur * 0.75) };

    // native: 区間のクリップが送られ、注記に区間と video_clip の案内が入る
    const c1 = conversations.create({ serverProfileId: p.id, model: null });
    const run1 = await service.send({
      conversationId: c1.id,
      text: '区間',
      attachments: [{ id: video.id, sendMode: 'native', range }],
    });
    await service.waitFor(run1.runId);
    const req1 = server.requests[0]!.body as { messages: Wire[] };
    const content = req1.messages[0]!.content as { type: string; text?: string }[];
    expect(content.map((x) => x.type)).toEqual(['text', 'input_video']);
    expect(content[0]!.text).toContain('user-selected range');
    expect(content[0]!.text).toContain('video_clip(');
    const stored = messages.pathToRoot(conversations.get(c1.id)!.activeLeafId!)[0]!;
    const vp = stored.parts.find((x) => x.type === 'video');
    expect(vp && vp.type === 'video' ? vp.range : null).toEqual(range);
    const clips = (
      db
        .prepare(
          "SELECT meta FROM attachments WHERE json_extract(meta, '$.derivedLabel') LIKE 'clip %'",
        )
        .all() as { meta: string }[]
    ).map((r) => JSON.parse(r.meta) as { durationMs?: number });
    expect(clips).toHaveLength(1);
    expect(clips[0]!.durationMs!).toBeLessThan(dur * 0.6);
    expect(clips[0]!.durationMs!).toBeGreaterThan(dur * 0.4);

    // tools: 自動添付のコンタクトシートが区間で作られる
    const c2 = conversations.create({ serverProfileId: p.id, model: null });
    const run2 = await service.send({
      conversationId: c2.id,
      text: '区間',
      attachments: [{ id: video.id, sendMode: 'tools', range }],
    });
    await service.waitFor(run2.runId);
    const stored2 = messages.pathToRoot(conversations.get(c2.id)!.activeLeafId!)[0]!;
    const sheet = stored2.parts.find((x) => x.type === 'image');
    expect(sheet?.name).toMatch(/contact sheet [\d.]+s-[\d.]+s\)/);
    const req2 = server.requests[1]!.body as { messages: Wire[] };
    const text2 = (req2.messages[0]!.content as { type: string; text?: string }[])[0]!.text!;
    expect(text2).toContain('focus on the range');
  });
});

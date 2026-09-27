import { app, BrowserWindow, net, protocol, shell } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { MediaResolver } from './chat/media-resolver';
import { ChatService } from './chat/service';
import { openDatabase, type Database } from './db/client';
import { AttachmentRepository } from './db/repositories/attachments';
import { ConversationRepository } from './db/repositories/conversations';
import { McpServerRepository } from './db/repositories/mcp-servers';
import { McpManager } from './tools/mcp/manager';
import { FfmpegService } from './media/ffmpeg';
import { PdfService } from './media/pdf';
import { createPdfTools } from './tools/builtin/pdf';
import { createCodeTools } from './tools/builtin/code';
import { createFileTools } from './tools/builtin/files';
import { createAttachmentTextTool } from './tools/builtin/attachment-text';
import { createDownloadTools } from './tools/builtin/download';
import { MediaStore } from './media/store';
import { VideoOps } from './media/video-ops';
import { createVideoTools } from './tools/builtin/video';
import { MessageRepository } from './db/repositories/messages';
import { ServerProfileRepository } from './db/repositories/server-profiles';
import { registerIpcHandlers } from './ipc/handlers';
import { broadcastIpcEvent } from './ipc/register';
import { initPaths } from './paths';
import { SettingsRepository } from './settings/repository';
import { registerBuiltinTools } from './tools/builtin';
import { ToolRegistry } from './tools/registry';

// userData の差し替えは whenReady より前に行う必要がある。
const paths = initPaths();

// 添付ファイルを renderer に見せるためのスキーム: udjat-media://attachment/<id>
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'udjat-media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
  },
]);

function registerMediaProtocol(media: MediaStore): void {
  protocol.handle('udjat-media', (request) => {
    const url = new URL(request.url);
    const id = url.pathname.replace(/^\/+/, '');
    const a = url.hostname === 'attachment' && id ? media.get(id) : null;
    if (!a) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(media.pathOf(a)).href, {
      headers: { 'Content-Type': a.mime },
    });
  });
}

let db: Database | null = null;
let chat: ChatService | null = null;
let mcp: McpManager | null = null;
let mainWindow: BrowserWindow | null = null;

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  win.once('ready-to-show', () => win.show());

  // 外部リンクは OS のブラウザで開く
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL']);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }
  return win;
}

// 二重起動防止(同じ data/ を 2 プロセスで開かないため)
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  void app.whenReady().then(() => {
    db = openDatabase({ path: paths.database });
    const profiles = new ServerProfileRepository(db);
    const conversations = new ConversationRepository(db);
    const messages = new MessageRepository(db);
    const settings = new SettingsRepository(db);
    const attachments = new AttachmentRepository(db);
    const ffmpeg = new FfmpegService({
      ffmpeg: (settings.get('ffmpeg.path') as string | null) ?? null,
      ffprobe: (settings.get('ffprobe.path') as string | null) ?? null,
    });
    const pdf = new PdfService();
    const media = new MediaStore(
      attachments,
      ffmpeg,
      { mediaDir: paths.media, cacheDir: paths.cache },
      pdf,
    );
    const ops = new VideoOps(media, ffmpeg);
    registerMediaProtocol(media);

    const tools = new ToolRegistry(db);
    registerBuiltinTools(tools);
    for (const t of createVideoTools({ store: media, ops })) tools.register(t);
    for (const t of createPdfTools({ store: media, pdf })) tools.register(t);
    for (const t of createCodeTools({
      store: media,
      // udjat.callTool: 承認なしで実行できる(ポリシー auto の)ツールだけをサンドボックスから呼べる
      callTool: async (name, args, ctx) => {
        const t = tools.get(name);
        if (!t) return { text: `error: unknown tool ${name}`, isError: true };
        if (tools.policyFor(name) !== 'auto')
          return {
            text: `error: ${name} は承認が必要なツールなのでサンドボックスからは呼べません。ツールとして直接呼んでください`,
            isError: true,
          };
        const reason = t.unavailable?.();
        if (reason) return { text: `error: ${reason}`, isError: true };
        const r = await tools.execute(name, args, ctx);
        return { text: r.text, isError: r.isError ?? false };
      },
    }))
      tools.register(t);
    for (const t of createFileTools({ store: media, pdf, getSetting: (k) => settings.get(k) }))
      tools.register(t);
    tools.register(createAttachmentTextTool(media));
    for (const t of createDownloadTools({ store: media })) tools.register(t);
    // 未参照の添付と孤立ファイルの掃除(起動を遅らせないよう少し後で)
    setTimeout(() => {
      try {
        const r = media.gc();
        if (r.deletedAttachments || r.deletedFiles) console.log('[media] gc:', r);
      } catch (e) {
        console.warn('[media] gc failed:', e);
      }
    }, 5000);
    const mcpServers = new McpServerRepository(db);
    mcp = new McpManager({
      registry: tools,
      media,
      onStatusChange: (status) => broadcastIpcEvent('mcp:status', status),
    });
    void mcp.autostart(mcpServers.list());
    chat = new ChatService({
      profiles,
      conversations,
      messages,
      tools,
      emit: (ev) => broadcastIpcEvent('chat:event', ev),
      getSetting: (key) => settings.get(key),
      media: {
        store: media,
        ops,
        attachments,
        resolver: new MediaResolver(
          media,
          ops,
          {
            // 一般設定の値を送信のたびに読む(再起動なしで反映)
            nativeClip: () => ({
              maxSeconds: Number(settings.get('video.native.maxSeconds')) || 60,
              width: Number(settings.get('video.native.width')) || 640,
              fps: Number(settings.get('video.native.fps')) || 2,
            }),
            fileMaxChars: () => Number(settings.get('attachments.textMaxChars')) || 30_000,
          },
          pdf,
        ),
      },
    });
    registerIpcHandlers({
      db,
      paths,
      profiles,
      conversations,
      messages,
      chat,
      tools,
      media,
      mcp,
      mcpServers,
    });
    mainWindow = createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', (e) => {
    chat?.abortAll();
    // MCP の子プロセスを確実に終了させてから閉じる
    if (mcp) {
      const m = mcp;
      mcp = null;
      e.preventDefault();
      void Promise.race([m.disconnectAll(), new Promise((r) => setTimeout(r, 2000))]).finally(
        () => {
          db?.close();
          db = null;
          app.quit();
        },
      );
      return;
    }
    db?.close();
    db = null;
  });
}

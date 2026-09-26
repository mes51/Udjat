import { app, BrowserWindow, shell } from 'electron';
import { join } from 'node:path';
import { ChatService } from './chat/service';
import { openDatabase, type Database } from './db/client';
import { ConversationRepository } from './db/repositories/conversations';
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

let db: Database | null = null;
let chat: ChatService | null = null;
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
    const tools = new ToolRegistry(db);
    registerBuiltinTools(tools);
    chat = new ChatService({
      profiles,
      conversations,
      messages,
      tools,
      emit: (ev) => broadcastIpcEvent('chat:event', ev),
      getSetting: (key) => settings.get(key),
    });
    registerIpcHandlers({ db, paths, profiles, conversations, messages, chat, tools });
    mainWindow = createWindow();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    chat?.abortAll();
    db?.close();
    db = null;
  });
}

import { app, BrowserWindow, dialog } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { binariesAvailable, resolveBinaries } from '@main/media/binaries';
import { exportSettings, importSettings } from '@main/settings/backup';
import { extname, join } from 'node:path';
import type { ServerProfile, ServerProfileInput } from '@shared/schemas';
import { ModelManagementSchema } from '@shared/schemas';
import { exportFileName, exportJson, exportMarkdown } from '@main/chat/export';
import type { ChatService } from '@main/chat/service';
import type { ToolRegistry } from '@main/tools/registry';
import type { McpManager } from '@main/tools/mcp/manager';
import { parseMcpServersJson, toMcpServersJson } from '@main/tools/mcp/mcp-config';
import type { McpServerRepository } from '@main/db/repositories/mcp-servers';
import type { MediaStore } from '@main/media/store';
import { mimeFromName } from '@main/media/store';
import type { Database } from '@main/db/client';
import { sqliteVersion } from '@main/db/client';
import type { ConversationRepository } from '@main/db/repositories/conversations';
import type { MessageRepository } from '@main/db/repositories/messages';
import type { ServerProfileRepository } from '@main/db/repositories/server-profiles';
import type { ResolvedPaths } from '@main/paths';
import { getAdapter } from '@main/providers';
import { SettingsRepository } from '@main/settings/repository';
import { handleIpc } from './register';

export interface AppContext {
  db: Database;
  paths: ResolvedPaths;
  profiles: ServerProfileRepository;
  conversations: ConversationRepository;
  messages: MessageRepository;
  chat: ChatService;
  tools: ToolRegistry;
  media: MediaStore;
  mcp: McpManager;
  mcpServers: McpServerRepository;
}

export function registerIpcHandlers(ctx: AppContext): void {
  const settings = new SettingsRepository(ctx.db);

  handleIpc('app:info', () => ({
    name: app.getName(),
    version: app.getVersion(),
    dataDir: ctx.paths.root,
    dataDirMode: ctx.paths.mode,
    versions: {
      electron: process.versions.electron ?? '',
      node: process.versions.node,
      chrome: process.versions.chrome ?? '',
      sqlite: sqliteVersion(ctx.db),
    },
  }));

  handleIpc('settings:get', ({ key }) => settings.get(key) ?? null);
  handleIpc('settings:set', ({ key, value }) => {
    settings.set(key, value);
    return undefined;
  });
  handleIpc('settings:all', () => settings.all());

  // --- サーバープロファイル ---
  handleIpc('profiles:list', () => ctx.profiles.list());
  handleIpc('profiles:create', (input) => ctx.profiles.create(input));
  handleIpc('profiles:update', ({ id, patch }) => {
    const p = ctx.profiles.update(id, patch);
    if (!p) throw new Error('プロファイルが見つかりません');
    return p;
  });
  handleIpc('profiles:delete', ({ id }) => ctx.profiles.delete(id));
  handleIpc('profiles:models', async ({ profileId }) => {
    const p = ctx.profiles.get(profileId);
    if (!p) throw new Error('プロファイルが見つかりません');
    return getAdapter(p.kind).listModels(p);
  });
  handleIpc('profiles:test', async (input) => {
    const temp = tempProfile(input);
    try {
      const models = await getAdapter(temp.kind).listModels(temp);
      return { ok: true, models, error: null };
    } catch (e) {
      return { ok: false, models: [], error: (e as Error).message };
    }
  });
  handleIpc('models:capabilities', async ({ profileId, model }) => {
    const p = ctx.profiles.get(profileId);
    if (!p) throw new Error('プロファイルが見つかりません');
    return ctx.chat.capabilitiesFor(p, model);
  });
  handleIpc('models:status', async ({ profileId }) => {
    const p = ctx.profiles.get(profileId);
    if (!p) throw new Error('プロファイルが見つかりません');
    return ctx.chat.modelStatus(p);
  });
  handleIpc('models:load', async ({ profileId, model }) => {
    const p = ctx.profiles.get(profileId);
    if (!p) throw new Error('プロファイルが見つかりません');
    return ctx.chat.loadModel(p, model);
  });
  handleIpc('models:unload', async ({ profileId, model }) => {
    const p = ctx.profiles.get(profileId);
    if (!p) throw new Error('プロファイルが見つかりません');
    return ctx.chat.unloadModel(p, model);
  });
  handleIpc('models:setCapabilities', async ({ profileId, model, overrides }) => {
    const p = ctx.profiles.setModelCapabilities(profileId, model, overrides);
    if (!p) throw new Error('プロファイルが見つかりません');
    return ctx.chat.capabilitiesFor(p, model);
  });

  // --- 会話 ---
  handleIpc('conversations:list', () => ctx.conversations.list());
  handleIpc('conversations:create', ({ serverProfileId, model }) => {
    // プロファイル未指定なら最初のプロファイルを既定にする
    const profile =
      (serverProfileId ? ctx.profiles.get(serverProfileId) : null) ??
      ctx.profiles.list()[0] ??
      null;
    // 入力欄で最後に切り替えたカテゴリの状態を新しい会話にも引き継ぐ
    const defaults = settings.get('tools.defaultDisabledCategories');
    return ctx.conversations.create({
      serverProfileId: profile?.id ?? null,
      model: model ?? profile?.defaultModel ?? null,
      disabledCategories: Array.isArray(defaults)
        ? defaults.filter((x): x is string => typeof x === 'string')
        : [],
    });
  });
  handleIpc('conversations:get', ({ id }) => ctx.conversations.get(id));
  handleIpc('conversations:update', ({ id, patch }) => {
    const c = ctx.conversations.update(id, patch, { touch: false });
    if (!c) throw new Error('会話が見つかりません');
    return c;
  });
  handleIpc('conversations:delete', ({ id }) => {
    const running = ctx.chat.isRunning(id);
    if (running) ctx.chat.abort(running);
    return ctx.conversations.delete(id);
  });

  // --- メッセージ ---
  handleIpc('messages:path', ({ conversationId }) => {
    const conv = ctx.conversations.get(conversationId);
    if (!conv?.activeLeafId) return [];
    return ctx.messages.pathToRoot(conv.activeLeafId);
  });
  handleIpc('messages:branches', ({ conversationId }) => {
    const conv = ctx.conversations.get(conversationId);
    if (!conv?.activeLeafId) return {};
    return ctx.messages.branches(ctx.messages.pathToRoot(conv.activeLeafId));
  });
  handleIpc('messages:switchBranch', ({ conversationId, messageId }) => {
    const target = ctx.messages.get(messageId);
    if (!target || target.conversationId !== conversationId)
      throw new Error('メッセージが見つかりません');
    const leaf = ctx.messages.latestLeafUnder(messageId);
    const conv = ctx.conversations.update(
      conversationId,
      { activeLeafId: leaf.id },
      { touch: false },
    );
    if (!conv) throw new Error('会話が見つかりません');
    return conv;
  });
  handleIpc('messages:search', ({ query, limit }) => ctx.messages.search(query, limit));
  handleIpc('conversations:export', ({ id, format }) => {
    const conv = ctx.conversations.get(id);
    if (!conv) throw new Error('会話が見つかりません');
    if (format === 'markdown') {
      const path = conv.activeLeafId ? ctx.messages.pathToRoot(conv.activeLeafId) : [];
      return { fileName: exportFileName(conv, 'md'), content: exportMarkdown(conv, path) };
    }
    const all = ctx.messages.listByConversation(id);
    const ids = new Set<string>();
    for (const m of all)
      for (const p of m.parts)
        if (p.type !== 'text' && p.type !== 'reasoning') ids.add(p.attachmentId);
    const attachments = [...ids]
      .map((a) => ctx.media.get(a))
      .filter((a): a is NonNullable<typeof a> => !!a);
    return { fileName: exportFileName(conv, 'json'), content: exportJson(conv, all, attachments) };
  });
  handleIpc('files:save', async ({ fileName, content }) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const ext = extname(fileName).slice(1);
    const filters =
      ext === 'md'
        ? [{ name: 'Markdown', extensions: ['md'] }]
        : ext === 'json'
          ? [{ name: 'JSON', extensions: ['json'] }]
          : [];
    const opts = {
      defaultPath: join(app.getPath('documents'), fileName),
      filters: [...filters, { name: 'すべてのファイル', extensions: ['*'] }],
    };
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return null;
    writeFileSync(r.filePath, content, 'utf8');
    return r.filePath;
  });

  // --- チャット ---
  handleIpc('chat:send', ({ conversationId, text, attachments }) => {
    if (ctx.chat.isRunning(conversationId)) throw new Error('この会話は応答生成中です');
    return ctx.chat.send({ conversationId, text, ...(attachments ? { attachments } : {}) });
  });
  handleIpc('chat:edit', ({ messageId, text }) => ctx.chat.edit(messageId, text));
  handleIpc('chat:regenerate', ({ messageId }) => ctx.chat.regenerate(messageId));
  handleIpc('chat:abort', ({ runId }) => ctx.chat.abort(runId));
  handleIpc('chat:running', ({ conversationId }) => ctx.chat.isRunning(conversationId));

  // --- 添付 ---
  handleIpc('attachments:addBytes', ({ name, mime, base64 }) =>
    ctx.media.addBytes(
      Buffer.from(base64, 'base64'),
      name || `pasted.${mime.split('/')[1] ?? 'bin'}`,
      mime,
    ),
  );
  handleIpc('attachments:addPath', ({ path, name }) =>
    ctx.media.addFile(path, {
      ...(name ? { originalName: name } : {}),
      mime: mimeFromName(name ?? path),
    }),
  );
  handleIpc('attachments:get', ({ id }) => ctx.media.get(id));

  // --- 設定のバックアップ、ffmpeg ---
  handleIpc('settings:exportAll', ({ includeSecrets }) =>
    exportSettings(
      { settings, profiles: ctx.profiles, mcpServers: ctx.mcpServers, tools: ctx.tools },
      { includeSecrets },
    ),
  );
  handleIpc('settings:importAll', ({ json }) =>
    importSettings(
      { settings, profiles: ctx.profiles, mcpServers: ctx.mcpServers, tools: ctx.tools },
      json,
    ),
  );
  handleIpc('media:binaries', () => {
    const custom = {
      ffmpeg: (settings.get('ffmpeg.path') as string | null) || null,
      ffprobe: (settings.get('ffprobe.path') as string | null) || null,
    };
    const bins = resolveBinaries(custom);
    const avail = binariesAvailable(bins);
    return {
      ffmpeg: { path: bins.ffmpeg, available: avail.ffmpeg, custom: !!custom.ffmpeg },
      ffprobe: { path: bins.ffprobe, available: avail.ffprobe, custom: !!custom.ffprobe },
    };
  });
  handleIpc('files:open', async ({ extensions }) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const opts = {
      properties: ['openFile' as const],
      filters: [
        ...(extensions && extensions.length > 0
          ? [{ name: extensions.join(', '), extensions }]
          : []),
        { name: 'すべてのファイル', extensions: ['*'] },
      ],
    };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    const path = r.filePaths[0];
    if (r.canceled || !path) return null;
    return { path, content: readFileSync(path, 'utf8') };
  });

  // --- MCP ---
  handleIpc('mcp:list', () => {
    const servers = ctx.mcpServers.list();
    return { servers, statuses: servers.map((s) => ctx.mcp.status(s)) };
  });
  handleIpc('mcp:create', (input) => ctx.mcpServers.create(input));
  handleIpc('mcp:update', async ({ id, patch }) => {
    const s = ctx.mcpServers.update(id, patch);
    if (!s) throw new Error('MCP サーバーが見つかりません');
    // 接続中に設定が変わったら繋ぎ直す。無効化されたら切断
    if (ctx.mcp.isConnected(id)) {
      if (s.enabled) void ctx.mcp.connect(s);
      else await ctx.mcp.disconnect(id);
    }
    return s;
  });
  handleIpc('mcp:delete', async ({ id }) => {
    await ctx.mcp.disconnect(id);
    return ctx.mcpServers.delete(id);
  });
  handleIpc('mcp:connect', ({ id }) => {
    const s = ctx.mcpServers.get(id);
    if (!s) throw new Error('MCP サーバーが見つかりません');
    return ctx.mcp.connect(s);
  });
  handleIpc('mcp:disconnect', async ({ id }) => {
    await ctx.mcp.disconnect(id);
    return undefined;
  });
  handleIpc('mcp:importJson', ({ json }) => {
    const inputs = parseMcpServersJson(json);
    const existing = ctx.mcpServers.list();
    let created = 0;
    let updated = 0;
    for (const input of inputs) {
      const same = existing.find((s) => s.name === input.name);
      if (same) {
        ctx.mcpServers.update(same.id, input);
        updated++;
      } else {
        ctx.mcpServers.create(input);
        created++;
      }
    }
    return { created, updated };
  });
  handleIpc('mcp:exportJson', () => toMcpServersJson(ctx.mcpServers.list()));

  // --- ツール ---
  handleIpc('tools:list', () => ctx.tools.list());
  handleIpc('tools:setPolicy', ({ name, policy }) => {
    ctx.tools.setPolicy(name, policy);
    return undefined;
  });
  handleIpc('tools:approve', ({ runId, callId, decision }) =>
    ctx.chat.approve(runId, callId, decision),
  );
}

function tempProfile(input: ServerProfileInput): ServerProfile {
  return {
    ...input,
    modelCapabilityOverrides: input.modelCapabilityOverrides ?? {},
    modelManagement: ModelManagementSchema.parse(input.modelManagement ?? {}),
    id: 'temp',
    createdAt: 0,
    updatedAt: 0,
  };
}

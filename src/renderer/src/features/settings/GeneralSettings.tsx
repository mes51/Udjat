import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { AppInfo } from '@shared/ipc-schema';
import { Button } from '@renderer/components/ui/button';
import { useConfirm } from '@renderer/components/ui/confirm';
import { Field, Input, Select } from '@renderer/components/ui/input';
import { invoke } from '@renderer/lib/ipc';
import { useSetting, useSettingMutation } from '@renderer/lib/queries';
import { setTheme, type ThemeSetting } from '@renderer/lib/theme';

function ThemeSelect() {
  const theme = useSetting<ThemeSetting>('ui.theme');
  const save = useSettingMutation();
  const value = theme.data ?? 'system';
  return (
    <Field label="テーマ">
      <Select
        value={value}
        disabled={!theme.isFetched}
        onChange={(e) => {
          const v = e.target.value as ThemeSetting;
          setTheme(v);
          save.mutate({ key: 'ui.theme', value: v });
        }}
      >
        <option value="system">OS に従う</option>
        <option value="dark">ダーク</option>
        <option value="light">ライト</option>
      </Select>
    </Field>
  );
}

function AutoTitleSetting() {
  const autoTitle = useSetting<boolean>('titles.auto');
  const save = useSettingMutation();
  const enabled = autoTitle.data !== false;
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={enabled}
        disabled={!autoTitle.isFetched || save.isPending}
        onChange={(e) => save.mutate({ key: 'titles.auto', value: e.target.checked })}
      />
      最初の往復が終わったら、モデルに会話タイトルを付けさせる
    </label>
  );
}

function FfmpegSettings() {
  const bins = useQuery({ queryKey: ['media:binaries'], queryFn: () => invoke('media:binaries') });
  const ffmpegPath = useSetting<string>('ffmpeg.path');
  const ffprobePath = useSetting<string>('ffprobe.path');
  const save = useSettingMutation();
  const qc = useQueryClient();
  const [form, setForm] = useState<{ ffmpeg: string; ffprobe: string } | null>(null);
  const cur = form ?? { ffmpeg: ffmpegPath.data ?? '', ffprobe: ffprobePath.data ?? '' };
  const persist = async () => {
    await save.mutateAsync({ key: 'ffmpeg.path', value: cur.ffmpeg.trim() || null });
    await save.mutateAsync({ key: 'ffprobe.path', value: cur.ffprobe.trim() || null });
    setForm(null);
    void qc.invalidateQueries({ queryKey: ['media:binaries'] });
  };
  const status = (b: { path: string; available: boolean; custom: boolean } | undefined) =>
    !b
      ? '…'
      : `${b.available ? '使用可' : '見つかりません'} · ${b.custom ? '手動指定' : '同梱'}: ${b.path}`;
  return (
    <div className="flex flex-col gap-2">
      <Field label="ffmpeg のパス(空なら同梱版)" hint={status(bins.data?.ffmpeg)}>
        <Input
          value={cur.ffmpeg}
          onChange={(e) => setForm({ ...cur, ffmpeg: e.target.value })}
          placeholder="C:\\tools\\ffmpeg\\bin\\ffmpeg.exe"
        />
      </Field>
      <Field label="ffprobe のパス(空なら同梱版)" hint={status(bins.data?.ffprobe)}>
        <Input
          value={cur.ffprobe}
          onChange={(e) => setForm({ ...cur, ffprobe: e.target.value })}
          placeholder="C:\\tools\\ffmpeg\\bin\\ffprobe.exe"
        />
      </Field>
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          disabled={form === null || save.isPending}
          onClick={() => void persist()}
        >
          保存(再起動後に反映)
        </Button>
      </div>
    </div>
  );
}

function BackupSettings() {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [msg, setMsg] = useState<string | null>(null);
  const exportAll = async (includeSecrets: boolean) => {
    const json = await invoke('settings:exportAll', { includeSecrets });
    const saved = await invoke('files:save', {
      fileName: `udjat-settings-${new Date().toISOString().slice(0, 10)}.json`,
      content: json,
    });
    if (saved) setMsg(`保存しました: ${saved}`);
  };
  const importAll = useMutation({
    mutationFn: async () => {
      const file = await invoke('files:open', { extensions: ['json'] });
      if (!file) return null;
      const ok = await confirm({
        title: '設定を取り込みますか?',
        description: `${file.path}\n同名のプロファイルと MCP サーバーは上書きされ、設定はマージされます。`,
        confirmLabel: '取り込む',
      });
      if (!ok) return null;
      return invoke('settings:importAll', { json: file.content });
    },
    onSuccess: (r) => {
      if (!r) return;
      setMsg(
        `取り込み: 設定 ${r.settings}、プロファイル ${r.profiles}、MCP ${r.mcpServers}、ツールポリシー ${r.toolPolicies}`,
      );
      void qc.invalidateQueries();
    },
    onError: (e) => setMsg(String(e)),
  });
  return (
    <div className="flex flex-col gap-2">
      <p className="text-fg-muted text-xs">
        サーバープロファイル、MCP サーバー、ツールのポリシー、各種設定を JSON
        に書き出します。会話と添付は含みません(data/ フォルダごとコピーしてください)。
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" onClick={() => void exportAll(false)}>
          書き出す(API キーを除く)
        </Button>
        <Button variant="secondary" size="sm" onClick={() => void exportAll(true)}>
          書き出す(API キーを含む)
        </Button>
        <Button
          variant="secondary"
          size="sm"
          disabled={importAll.isPending}
          onClick={() => importAll.mutate()}
        >
          取り込む…
        </Button>
      </div>
      {msg && <p className="text-fg-muted text-xs">{msg}</p>}
    </div>
  );
}

function AppInfoLine() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  useEffect(() => {
    void invoke('app:info').then(setInfo);
  }, []);
  if (!info) return null;
  return (
    <div className="text-fg-muted/70 text-[11px]">
      Udjat {info.version} · データ: {info.dataDirMode} ({info.dataDir}) · Electron{' '}
      {info.versions.electron} · SQLite {info.versions.sqlite}
    </div>
  );
}

export function GeneralSettings() {
  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">表示</h3>
        <ThemeSelect />
        <AutoTitleSetting />
      </section>
      <section>
        <h3 className="mb-2 text-sm font-medium">ffmpeg</h3>
        <FfmpegSettings />
      </section>
      <section>
        <h3 className="mb-2 text-sm font-medium">設定のバックアップ</h3>
        <BackupSettings />
      </section>
      <section>
        <h3 className="mb-2 text-sm font-medium">キーボードショートカット</h3>
        <ul className="text-fg-muted grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
          <li>
            <kbd>Ctrl+N</kbd> 新しい会話
          </li>
          <li>
            <kbd>Ctrl+K</kbd> 検索
          </li>
          <li>
            <kbd>Ctrl+,</kbd> 設定
          </li>
          <li>
            <kbd>Esc</kbd> 生成を停止
          </li>
          <li>
            <kbd>Enter</kbd> 送信 / <kbd>Shift+Enter</kbd> 改行
          </li>
        </ul>
      </section>
      <AppInfoLine />
    </div>
  );
}

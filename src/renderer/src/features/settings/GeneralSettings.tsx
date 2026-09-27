import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { AppInfo } from '@shared/ipc-schema';
import { Button } from '@renderer/components/ui/button';
import { useConfirm } from '@renderer/components/ui/confirm';
import { Field, Input, Select } from '@renderer/components/ui/input';
import { Section, SectionTitle } from '@renderer/components/ui/section';
import { invoke } from '@renderer/lib/ipc';
import { useSetting, useSettingMutation } from '@renderer/lib/queries';
import { setTheme, type ThemeSetting } from '@renderer/lib/theme';

/**
 * 一般タブ。値はすべて「変更した時 / フォーカスを外した時」に保存する(保存ボタンは置かない)。
 * ffmpeg のパスだけは再起動後に反映される旨をヒントに書く。
 */

function ThemeSelect() {
  const theme = useSetting<ThemeSetting>('ui.theme');
  const save = useSettingMutation();
  const value = theme.data ?? 'system';
  return (
    <Field label="テーマ">
      <Select
        value={value}
        disabled={!theme.isFetched}
        className="max-w-xs"
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

function AutoCompactSetting() {
  const auto = useSetting<boolean>('context.autoCompact');
  const save = useSettingMutation();
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={auto.data === true}
        disabled={!auto.isFetched || save.isPending}
        onChange={(e) => save.mutate({ key: 'context.autoCompact', value: e.target.checked })}
      />
      閾値を超えていたら、送信前に自動で会話を要約して圧縮する
    </label>
  );
}

/** フォーカスを外した時に保存するテキスト入力(設定キー 1 つに対応) */
function SettingInput({
  settingKey,
  label,
  hint,
  placeholder,
  type,
  parse,
  format,
  className,
  onSaved,
}: {
  settingKey: string;
  label: string;
  hint?: string | undefined;
  placeholder?: string;
  type?: 'text' | 'number';
  /** 入力文字列を保存する値に変換する。null を返すと設定を消す */
  parse: (text: string) => unknown;
  /** 保存されている値を入力文字列にする */
  format: (value: unknown) => string;
  className?: string;
  onSaved?: () => void;
}) {
  const setting = useSetting<unknown>(settingKey);
  const save = useSettingMutation();
  const [text, setText] = useState<string | null>(null);
  const shown = text ?? format(setting.data);
  const commit = () => {
    if (text === null) return;
    const next = parse(text);
    setText(null);
    if (format(next) === format(setting.data)) return;
    save.mutate({ key: settingKey, value: next }, onSaved ? { onSuccess: () => onSaved() } : {});
  };
  return (
    <Field label={label} hint={hint}>
      <Input
        type={type ?? 'text'}
        value={shown}
        placeholder={placeholder}
        disabled={!setting.isFetched}
        className={className}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
    </Field>
  );
}

function FfmpegSettings() {
  const bins = useQuery({ queryKey: ['media:binaries'], queryFn: () => invoke('media:binaries') });
  const qc = useQueryClient();
  const status = (b: { path: string; available: boolean; custom: boolean } | undefined) =>
    !b
      ? '…'
      : `${b.available ? '使用可' : '見つかりません'} · ${b.custom ? '手動指定' : '同梱'}: ${b.path}`;
  const refresh = () => void qc.invalidateQueries({ queryKey: ['media:binaries'] });
  const pathParse = (t: string) => (t.trim() === '' ? null : t.trim());
  const pathFormat = (v: unknown) => (typeof v === 'string' ? v : '');
  return (
    <div className="flex max-w-2xl flex-col gap-3">
      <SettingInput
        settingKey="ffmpeg.path"
        label="ffmpeg のパス(空なら同梱版)"
        hint={`${status(bins.data?.ffmpeg)}。変更は再起動後に反映`}
        placeholder="C:\\tools\\ffmpeg\\bin\\ffmpeg.exe"
        parse={pathParse}
        format={pathFormat}
        onSaved={refresh}
      />
      <SettingInput
        settingKey="ffprobe.path"
        label="ffprobe のパス(空なら同梱版)"
        hint={`${status(bins.data?.ffprobe)}。変更は再起動後に反映`}
        placeholder="C:\\tools\\ffmpeg\\bin\\ffprobe.exe"
        parse={pathParse}
        format={pathFormat}
        onSaved={refresh}
      />
    </div>
  );
}

/** ネイティブ動画入力(llama.cpp / vLLM に動画をそのまま送る時)のクリップ設定 */
function NativeVideoSettings() {
  const numeric = (fallback: number, min: number, max: number) => ({
    parse: (t: string) => {
      const v = Number(t);
      return Number.isFinite(v) && v > 0 ? Math.min(max, Math.max(min, v)) : fallback;
    },
    format: (v: unknown) => String(typeof v === 'number' ? v : fallback),
  });
  return (
    <div className="grid max-w-2xl grid-cols-3 gap-3">
      <SettingInput
        settingKey="video.native.maxSeconds"
        label="最大秒数"
        hint="5〜600"
        type="number"
        {...numeric(60, 5, 600)}
      />
      <SettingInput
        settingKey="video.native.width"
        label="幅 (px)"
        hint="160〜1920"
        type="number"
        {...numeric(640, 160, 1920)}
      />
      <SettingInput
        settingKey="video.native.fps"
        label="fps"
        hint="0.5〜30"
        type="number"
        {...numeric(2, 0.5, 30)}
      />
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
    <div className="text-fg-subtle text-[11px]">
      Udjat {info.version} · データ: {info.dataDirMode} ({info.dataDir}) · Electron{' '}
      {info.versions.electron} · SQLite {info.versions.sqlite}
    </div>
  );
}

export function GeneralSettings() {
  return (
    <div className="flex flex-col gap-7">
      <Section className="gap-3">
        <SectionTitle description="変更はすぐ保存されます">表示</SectionTitle>
        <ThemeSelect />
        <AutoTitleSetting />
      </Section>
      <Section>
        <SectionTitle description="空なら同梱の ffmpeg / ffprobe を使います。フォーカスを外すと保存され、再起動後に反映されます">
          ffmpeg
        </SectionTitle>
        <FfmpegSettings />
      </Section>
      <Section>
        <SectionTitle description="動画をそのまま送れるモデルには縮小・低 fps 化したクリップを渡します。添付チップの「範囲」で区間を指定でき、指定が無ければ先頭からです。長い動画の他の部分はモデルが video_clip ツールで読み込みます(1 回の上限もこの最大秒数)">
          動画のネイティブ入力
        </SectionTitle>
        <NativeVideoSettings />
      </Section>
      <Section className="gap-3">
        <SectionTitle description="ヘッダーのメーターで使用量と上限を確認できます。閾値を超えると入力欄の上に圧縮を促すバナーが出ます">
          コンテキストの圧縮
        </SectionTitle>
        <AutoCompactSetting />
        <div className="grid max-w-2xl grid-cols-3 gap-3">
          <SettingInput
            settingKey="context.compactThreshold"
            label="閾値 (%)"
            hint="50〜99。既定 80"
            type="number"
            parse={(t) => {
              const v = Number(t);
              return Number.isFinite(v) && v > 0 ? Math.min(99, Math.max(50, Math.round(v))) : 80;
            }}
            format={(v) => String(typeof v === 'number' ? v : 80)}
          />
        </div>
      </Section>
      <Section>
        <SectionTitle description="テキスト系のファイル(.md / .txt / .json / ソースコードなど)は本文を展開してモデルに送ります。上限を超えた分はモデルが attachment_text ツールで読みます">
          添付ファイル
        </SectionTitle>
        <div className="grid max-w-2xl grid-cols-3 gap-3">
          <SettingInput
            settingKey="attachments.textMaxChars"
            label="展開する最大文字数"
            hint="1,000〜200,000"
            type="number"
            parse={(t) => {
              const v = Number(t);
              return Number.isFinite(v) && v > 0 ? Math.min(200_000, Math.max(1_000, v)) : 30_000;
            }}
            format={(v) => String(typeof v === 'number' ? v : 30_000)}
          />
        </div>
      </Section>
      <Section>
        <SectionTitle description="サーバープロファイル、MCP サーバー、ツールのポリシー、各種設定を JSON に書き出します。会話と添付は含みません(data/ フォルダごとコピーしてください)">
          設定のバックアップ
        </SectionTitle>
        <BackupSettings />
      </Section>
      <Section>
        <SectionTitle>キーボードショートカット</SectionTitle>
        <ul className="text-fg-muted grid max-w-md grid-cols-2 gap-x-6 gap-y-1.5 text-xs">
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
          <li className="col-span-2">
            <kbd>Enter</kbd> 送信 / <kbd>Shift+Enter</kbd> 改行
          </li>
        </ul>
      </Section>
      <AppInfoLine />
    </div>
  );
}

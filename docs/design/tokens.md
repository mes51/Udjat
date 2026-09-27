# トークン一覧

実体は `src/renderer/src/index.css`。Tailwind v4 の `@theme` に定義しているので、`bg-surface-2` `text-fg-muted` `border-border` `rounded-md` `shadow-panel` `font-mono` のようにクラスとして使える。透過は `bg-accent/15` のように付ける。

## 色

| トークン        | ダーク                 | ライト                 | 使う所                                        |
| --------------- | ---------------------- | ---------------------- | --------------------------------------------- |
| `surface`       | `#141311`              | `#f4f1ea`              | 地(チャット領域)                              |
| `surface-2`     | `#1b1a17`              | `#fbf9f5`              | サイドバー、入力欄、会話設定、ダイアログ      |
| `surface-3`     | `#252320`              | `#ebe6dc`              | カード、チップ、hover                         |
| `surface-4`     | `#2f2c27`              | `#e0d9cc`              | 押下、`code`、kbd                             |
| `border`        | `#2c2a25`              | `#dbd4c6`              | 通常の枠線・区切り                            |
| `border-strong` | `#3d3a33`              | `#c4bcab`              | hover した枠線、強い区切り、スクロールバー    |
| `fg`            | `#ece7dc`              | `#23201a`              | 本文                                          |
| `fg-muted`      | `#a59e91`              | `#6b6457`              | ラベル、補助文、アイコン                      |
| `fg-subtle`     | `#746d61`              | `#968e7f`              | 時刻、使用量、placeholder                     |
| `accent`        | `#e2a94f`              | `#b8730f`              | 主ボタン、選択、リンク、フォーカス            |
| `accent-strong` | `#eebb6a`              | `#9c6009`              | 主ボタンの hover                              |
| `accent-fg`     | `#1b1508`              | `#fffaf0`              | アクセントの上に載せる文字                    |
| `accent-soft`   | `rgba(226,169,79,.14)` | `rgba(184,115,15,.12)` | 選択行、承認カードの面(`bg-accent/10` と同等) |
| `success`       | `#62b98c`              | `#2f8f5b`              | 完了、常駐中                                  |
| `warning`       | `#e08a3c`              | `#c2601a`              | 権限の宣言、ロード中、注意                    |
| `danger`        | `#e5716f`              | `#c94f4f`              | エラー、削除、拒否                            |
| `info`          | `#7fb2e5`              | `#2f6fb8`              | 補足(今は未使用。青を使いたくなったらこれ)    |

コントラストの目安: 本文 `fg` は地に対して 12:1 以上、`fg-muted` は 6:1 以上、`fg-subtle` は 4:1 前後(メタ情報に限る)。アクセントの上の文字は `accent-fg` を使えば 8:1 以上になる。

## 角丸

| トークン    | 値   | 使う所                      |
| ----------- | ---- | --------------------------- |
| `radius-sm` | 6px  | 入力欄、チップ、kbd、`code` |
| `radius-md` | 8px  | ボタン、カード、一覧の行    |
| `radius-lg` | 12px | ダイアログ、パネル          |
| `radius-xl` | 14px | 入力欄の外枠                |

Tailwind の `rounded-sm/md/lg/xl` がそのままこの値になる。

## 影

| トークン         | 使う所                         |
| ---------------- | ------------------------------ |
| `shadow-panel`   | 入力欄の外枠(地の上に少し浮く) |
| `shadow-overlay` | ダイアログ、ドロップダウン     |

## 書体

| トークン    | 値                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------ |
| `font-sans` | Segoe UI Variable Text, Segoe UI, Yu Gothic UI, Hiragino Sans, Noto Sans JP, system-ui     |
| `font-mono` | Cascadia Code, Cascadia Mono, Consolas, SF Mono, Menlo, Roboto Mono, Noto Sans Mono CJK JP |

## 文字サイズ(トークンではなく規約)

| px  | クラス        | 用途                                 |
| --- | ------------- | ------------------------------------ |
| 11  | `text-[11px]` | 時刻、使用量、ヒント                 |
| 12  | `text-xs`     | ラベル、チップ、ツールカードの見出し |
| 13  | `text-[13px]` | 設定・ツールカードの本文、コード     |
| 14  | `text-sm`     | 一覧、フォーム、ボタン               |
| 15  | `text-[15px]` | チャット本文、入力欄                 |
| 16  | `text-base`   | ダイアログの見出し                   |

## 間隔(規約)

4px 刻み。部品内の padding は `px-2.5 py-1.5`(入力・チップ)、`px-3 py-2`(一覧の行・カード)、`px-4 py-3`(メッセージ行)、`px-5 py-4`(ダイアログの本文)。

## 追加する時

1. 役割で名前を付ける(色の名前にしない: `amber-2` ではなく `warning`)
2. ダークとライトの両方に値を入れる
3. この表と `index.css` の両方を更新する

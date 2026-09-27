# 部品の使い分け

実装は `src/renderer/src/components/ui/`(汎用)と `src/renderer/src/features/`(画面固有)。ここに無い見た目が要る時は、まず既存の部品の variant で表せないか考える。

## Button(`components/ui/button.tsx`)

| variant     | 使う所                                         | 例                                         |
| ----------- | ---------------------------------------------- | ------------------------------------------ |
| `default`   | その画面の主操作。1 画面(1 カード)に 1 つ      | 送信、保存、許可、追加                     |
| `secondary` | 主操作と並ぶ副操作                             | 接続テスト、書き出す、この会話では常に許可 |
| `outline`   | 補助的だが見えていてほしい操作                 | 再試行                                     |
| `ghost`     | アイコンボタン、行内の操作、hover で現れる操作 | 設定、ピン留め、編集、再生成               |
| `danger`    | 取り消せない操作                               | 削除、拒否                                 |

- サイズは `default`(32px)と `sm`(28px)、アイコンだけなら `icon` / `icon-sm`
- アイコン付きの文字ボタンは「アイコン + 半角スペース + 文字」(`<Send size={12} /> 送信`)
- 進行中は `disabled` にし、ラベルは変えない(「保存中…」にしない)。必要なら隣に `Loader2` を回す

## 区画と見出し(`components/ui/section.tsx`)

- `Section` + `SectionTitle`(小さな見出し、右に補助操作、下に 1 行の説明)で画面を区画に分ける。会話設定ドロワーと設定画面で共通
- 設定は「変更した瞬間 / フォーカスを外した時に保存」を基本にし、保存ボタンはフォーム一式を確定する時(サーバー、MCP サーバー、生成パラメータ)だけに置く
- 一覧 + 詳細の 2 カラムでは、一覧は幅 13〜14rem、選択行は `accent-soft`、2 行目に種別やモデル名を `fg-subtle` で

## Input / Textarea / Select / Field(`components/ui/input.tsx`)

- 必ず `Field` でラベルを付ける。ヒントは 1 文まで
- placeholder は「例: …」か「空なら既定」のように、空の意味を書く。ラベルの代わりに使わない
- 数値は `type="number"` + `step`。単位はラベルに書く(「最大秒数」「幅 (px)」)
- `Select` は `ui-select` クラスで矢印を描く。自前の `<select>` を書かない。ドロップダウンの option は index.css で背景 `surface-2` と文字 `fg` を明示している(背景を透明にした select でも読めるように)

## Dialog / ConfirmProvider

- 区画が多い画面(設定)は `Dialog` の `aside` に左ナビ(アイコン + ラベル、選択は `accent-soft`)を渡し、右側だけをスクロールさせる。ダイアログは幅 64rem・高さ 90vh に固定。右側の先頭に区画名と 1 行の説明を置き、ダイアログの見出しは「設定」だけにする
- 設定のようなまとまった画面は `Dialog`(幅 56rem まで、内側はタブ)
- はい/いいえの確認は `useConfirm()`。`window.confirm` / `alert` は使わない(Electron でキー入力が死ぬ)
- 取り消せない操作の確認は `danger: true` で、確認ボタンのラベルはその動詞(「削除」)

## チップ(入力欄のカテゴリ、添付)

- ON: `border-accent/60 bg-accent/15 text-fg`、OFF: `border-border text-fg-muted opacity-70`
- 角丸は `rounded-full`(カテゴリ)か `rounded-md`(添付)。文字は 11〜12px
- 部分的に有効な時は `3/5` のような数を `tabular-nums` で添える

## メッセージ行(`features/chat/MessageItem.tsx`)

- ユーザー行は `bg-surface-2/70` で地から少し上げる。assistant 行は地のまま
- アバターは 28px の角丸四角。ユーザーはアクセントの薄い面、assistant は `surface-3`
- 行内の操作(編集・再生成・ここから分岐)は `ghost` の `sm` で、hover 時だけ表示。分岐ナビ `< 2/3 >` は常に表示
- 使用量の行(モデル名・トークン・tok/s)は 11px `fg-subtle`。モデル名は `modelDisplayName()` で短くする
- 思考過程は折りたたみ(`surface-2` の枠)。生成中は開き、終わったら閉じる

## ツール関連(`features/chat/ToolBlocks.tsx`)

- 呼び出しと結果はどちらも `surface-2` の枠付きカード。見出しは 12px、等幅のツール名 + 状態(実行中… / 完了 / エラー)
- エラーは枠線を `danger/30` にし、アイコンを `danger` に。文字全体を赤くしない
- 承認カードは `bg-accent/10 border-accent/40`。コード実行の権限一覧はラベルを `warning` で
- ボタンは「許可」(default)、「この会話では常に許可」(secondary)、「拒否」(danger)の順

## 一覧(サイドバー、設定のプロファイル一覧)

- 行は `rounded-md px-2 py-1.5`、hover `surface-3`、選択 `bg-accent-soft text-fg`。未選択の文字は `fg-muted`
- 2 行目(時刻、種別)は 11px `fg-subtle`
- 行内の操作は hover で現れる `ghost` の `icon-sm`

## 状態の表示

| 状態         | 形                                           |
| ------------ | -------------------------------------------- |
| 生成中       | アクセントの点が点滅(サイドバー)、停止ボタン |
| ツール実行中 | `Loader2` の回転 + 「実行中…」               |
| モデル常駐   | 緑の点(`success`)+「常駐」                   |
| ロード中     | 琥珀の点(`warning`)が点滅 +「ロード中」      |
| エラー       | `danger/30` の枠 + `danger` のアイコン       |
| 空           | 中央に 1 文 + 次の操作のボタン               |

## スライダー付き数値(`components/ui/range.tsx`)

- 範囲が決まっている数値(temperature、top_p、top_k、min_p、repeat_penalty)は、スライダーと数値入力を 1 行に並べる。ラベル左・数値入力右、その下にスライダー、両端に min / max
- 値が空(既定)の時はつまみを `fg-subtle` にして「既定 (目安 0.8)」と添える。動かした瞬間に値が入る。「×」で既定に戻す
- 範囲がモデル次第のもの(最大出力トークン、コンテキスト長、seed)はテキスト入力だけ

## 状態と上書きの表(capability など)

- 思考(thinking)の切替は入力欄の上(ツールカテゴリの行の右端)に置く。「思考: 既定 / 有効 / (レベル)… / 無効」の 1 本のセレクトで、選んだ瞬間に保存する。レベルは capability の `reasoningLevels` から出し、保存済みの値が候補に無ければそれも出す。会話設定ドロワーには「保存」で確定する項目だけを置き、即保存の項目は入力欄に集める
- 「項目 / 現在 / 上書き」の 3 列。現在は点(`success` = あり、`fg-subtle` = なし)+ 短い語、上書きは 28px の `Select`
- 上書きが入っている行は `Select` の枠を `accent/60` にして分かるようにし、見出しの右に「自動推定に戻す」を出す
- 行は `divide-y` で区切り、カード 1 つに収める。要約を 1 行のテキストに詰め込まない(見切れる)

## 書かないこと

- `text-red-400` のような Tailwind の生の色。意味色トークンを使う
- `opacity` で文字を薄くする(`fg-muted` / `fg-subtle` を使う)
- `shadow-xl` などトークン外の影
- 位置を動かすアニメーション

## コードブロック

- 背景はブロックの面(`surface`)に統一し、シンタックスハイライト(shiki)はテーマ背景を使わず文字色だけを当てる(`span` に背景を付けると文字の部分だけ浮く)
- インラインコードは `surface-3` の面 + `radius-sm`

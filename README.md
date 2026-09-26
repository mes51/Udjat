# Udjat

LAN 上のローカル LLM サーバー(Ollama / LM Studio / llama.cpp / vLLM)に接続するデスクトップ用チャットクライアント。
動画を添付し、LLM 自身がツール呼び出しでフレームを取り出して理解できることを中核機能とする。

- 形態: Electron + React + TypeScript
- 状態: M3(画像 + 動画ツール)実装済み。M4(分岐・検索・エクスポート)未着手

## ドキュメント

計画は [docs/plan/00-overview.md](docs/plan/00-overview.md) から読む。

## 開発

必要なもの: Node 24 以上、pnpm 11 以上。Rust やビルドツールは不要(DB は Electron 同梱の `node:sqlite`)。

TypeScript は 7.0(ネイティブコンパイラ)を `tsc` に使う。TS 7.0 には Compiler API がないため、typescript-eslint 用に `typescript` パッケージ名を `@typescript/typescript6` の alias にしている(`tsc6` が 6.0 の tsc)。TS 7.1 対応の typescript-eslint が出たら alias を外す。

```bash
pnpm install
pnpm dev          # 開発起動(HMR)。データは ./.dev-data/ に入る
pnpm typecheck
pnpm lint
pnpm test
pnpm build        # out/ にビルド
pnpm dist         # release/ に zip(ポータブル)を生成
```

## データの置き場所

| モード   | 条件                                               | 場所                          |
| -------- | -------------------------------------------------- | ----------------------------- |
| dev      | `pnpm dev` / 未パッケージ                          | リポジトリ直下の `.dev-data/` |
| portable | exe の隣に `portable.marker` または `data/` がある | exe の隣の `data/`            |
| standard | 上記以外                                           | `%APPDATA%/Udjat`             |

`pnpm dist` の zip には `portable.marker` が同梱されるので、展開してそのまま使えばポータブルになる。

## ディレクトリ

```
src/main      Electron main(DB、IPC、後で LLM 通信・ツール・ffmpeg)
src/preload   contextBridge(sandbox 有効、shared/ipc-channels.ts のみ import)
src/renderer  React UI
src/shared    main と renderer で共有する型・スキーマ
docs/plan     設計ドキュメント
```

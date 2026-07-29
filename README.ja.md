# Agent Micro

Agent Micro は、ボタン・ダイヤル・ジョイスティックで Codex CLI を操作する macOS 用フローティングマクロパッドです。

言語： [한국어](README.md) · [English](README.en.md) · [简体中文](README.zh-CN.md)

貢献したい方は、まず [CONTRIBUTING.md](CONTRIBUTING.md) を読み、現在の方向性を [ROADMAP.md](ROADMAP.md) で確認してください。

## クイックスタート

Agent Micro は最大 6 個の Codex CLI セッションを管理し、承認・拒否、セッションの分岐、レビュー依頼、開発サーバーの起動を行えます。実際の AI 作業は Codex CLI が処理します。

### 必要なもの

- macOS
- Terminal、iTerm2、Ghostty などのターミナルアプリ
- Codex CLI を利用できる ChatGPT アカウント

### ソースから起動

```bash
git clone https://github.com/lumpenop/agent-micro.git
cd agent-micro
pnpm install
pnpm start
```

### 初回起動：3 つのステップ

1. **Codex に接続**：ChatGPT でログインします。
2. **プロジェクトを選択**：Codex が作業するフォルダーを選びます。
3. **最初の Agent を起動**：`Start` を押して最初のセッションを開きます。

同じ Mac ですでに Codex CLI にログインしている場合、1 の手順は自動的に完了することがあります。フォルダーと詳細設定は後から Settings で変更できます。

## 権限

ターミナルのフォーカス、分割、操作にはアクセシビリティ権限が必要です。**システム設定 → プライバシーとセキュリティ → アクセシビリティ**で Agent Micro を許可し、アプリとターミナルを再起動してください。

## 主な操作

| 操作 | 機能 |
| --- | --- |
| Agent 1–6 | CLI セッションを選択・起動 |
| Fast | 軽い推論モードに切り替え |
| Approve / Decline | Codex のリクエストに回答 |
| Fork | 空きスロットへセッションを分岐 |
| Review | 現在の変更をレビュー |
| DEV | 開発サーバーを起動・停止 |

まずは Agent 1 から始めてください。ダイヤルを回すと Codex・Prompts・Tools レイヤーが切り替わり、Touch でも同じレイヤーを 1 つ進められます。

## 分離された Agent Manager

Agent 1 はメイン調整用として維持されます。タスクを入力すると、Agent Manager が Agent 2–6 から空いている Worker を自動選択し、専用の Git worktree とブランチを作成して Codex を起動します。Worker の手動指定と先行タスク付きマージキューにも対応します。Worker セッションが消えた場合は安全な自動再起動を 1 回だけ行い、再失敗時は確認待ちにします。同一ファイル、dirty、競合、順序違反のマージを防ぎ、消えた worktree も復元できます。

## カスタム Provider

`Responses API · Codex Agent` には OpenAI Responses API 互換の Provider または Proxy が必要です。公開 DeepSeek API を含む Chat Completions 専用サービスで Codex の sandbox・承認・Agent セッションを維持するには、Responses 互換 Proxy が必要です。

## 開発とテスト

```bash
pnpm landing:dev
pnpm landing:build
pnpm test:safe
pnpm test:controls
pnpm test:providers
pnpm test:coordinator
pnpm test:coordinator:stress
```

本プロジェクトは MIT ライセンスで公開されています。

Agent Micro が役に立ったら、[GitHub で ⭐ Star](https://github.com/lumpenop/agent-micro) をお願いします。プロジェクトの成長に役立ちます。

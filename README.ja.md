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
git clone https://github.com/lumpenop/agent-keyboard.git
cd agent-keyboard
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

まずは Agent 1 から始めてください。ダイヤルは推論強度を、Touch は Codex・Prompts・Tools レイヤーを変更します。

## 開発とテスト

```bash
pnpm landing:dev
pnpm landing:build
pnpm test:safe
```

本プロジェクトは MIT ライセンスで公開されています。

Agent Micro が役に立ったら、[GitHub で ⭐ Star](https://github.com/lumpenop/agent-keyboard) をお願いします。プロジェクトの成長に役立ちます。

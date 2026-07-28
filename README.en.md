# Agent Micro

Agent Micro is a macOS floating macro pad for controlling Codex CLI with buttons, a dial, and a joystick.

Languages: [한국어](README.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

Want to help? Read [CONTRIBUTING.md](CONTRIBUTING.md) and see the current direction in [ROADMAP.md](ROADMAP.md).

## Quick start

Agent Micro controls up to six Codex CLI sessions. It can approve or decline requests, fork sessions, request reviews, and start development servers. The AI work itself is handled by Codex CLI.

### Requirements

- macOS
- Terminal, iTerm2, Ghostty, or another terminal app
- A ChatGPT account that can use Codex CLI

### Run from source

```bash
git clone https://github.com/lumpenop/agent-micro.git
cd agent-micro
pnpm install
pnpm start
```

### First launch: three steps

1. **Connect Codex** — sign in with ChatGPT.
2. **Choose a project** — select the folder Codex should work in.
3. **Start your first Agent** — press `Start` to open the first Codex session.

If Codex CLI is already logged in on this Mac, step 1 may complete automatically. Project folders and advanced options can be changed later in Settings.

## Permissions

Accessibility permission is required to focus, split, and control terminal windows. Enable Agent Micro in **System Settings → Privacy & Security → Accessibility**, then restart Agent Micro and your terminal.

## Main controls

| Control | Action |
| --- | --- |
| Agent 1–6 | Select or open a CLI session |
| Fast | Use a lighter reasoning mode |
| Approve / Decline | Respond to a Codex request |
| Fork | Branch the current session into an empty slot |
| Review | Ask Codex to review current changes |
| DEV | Start or stop the selected project's development server |

Start with Agent 1. Turning the dial switches between Codex, Prompts, and Tools layers; Touch advances the same layer selector.

## Isolated Agent Manager

Agent Manager gives every task its own Git worktree and branch. It detects overlapping files, blocks dirty or conflicting merges, restores a missing worktree from its branch, and automatically keeps a failed merge out of the main workspace.

## Custom providers

`Responses API · Codex Agent` requires an OpenAI Responses-compatible provider or proxy. Chat Completions-only services, including the public DeepSeek API, need a Responses-compatible proxy to retain Codex sandboxing, approvals, and Agent sessions.

## Development

```bash
pnpm landing:dev
pnpm landing:build
pnpm test:safe
pnpm test:controls
pnpm test:providers
pnpm test:coordinator
pnpm test:coordinator:stress
```

The project is released under the MIT license.

If Agent Micro is useful to you, consider leaving a [⭐ Star on GitHub](https://github.com/lumpenop/agent-micro). It helps the project grow.

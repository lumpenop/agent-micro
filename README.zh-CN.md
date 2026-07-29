# Agent Micro

Agent Micro 是一款 macOS 浮动宏键盘应用，可以通过按钮、旋钮和摇杆控制 Codex CLI。

语言： [한국어](README.md) · [English](README.en.md) · [日本語](README.ja.md)

想要参与贡献？请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)，并查看 [ROADMAP.md](ROADMAP.md) 了解当前方向。

## 快速开始

Agent Micro 可以管理最多 6 个 Codex CLI 会话，批准或拒绝请求、分支会话、发起代码审查和启动开发服务器。实际的 AI 工作由 Codex CLI 完成。

### 环境要求

- macOS
- Terminal、iTerm2、Ghostty 等终端应用
- 可以使用 Codex CLI 的 ChatGPT 账号

### 从源码运行

```bash
git clone https://github.com/lumpenop/agent-micro.git
cd agent-micro
pnpm install
pnpm start
```

### 首次启动：三个步骤

1. **连接 Codex**：使用 ChatGPT 登录。
2. **选择项目**：选择 Codex 要操作的文件夹。
3. **启动第一个 Agent**：点击 `Start` 打开第一个 Codex 会话。

如果这台 Mac 已经登录过 Codex CLI，第 1 步可能会自动完成。项目文件夹和高级选项之后可以在 Settings 中修改。

## 权限

聚焦、分屏和控制终端窗口需要辅助功能权限。请在 **系统设置 → 隐私与安全性 → 辅助功能** 中允许 Agent Micro，然后重启应用和终端。

## 主要操作

| 操作 | 功能 |
| --- | --- |
| Agent 1–6 | 选择或打开 CLI 会话 |
| Fast | 使用更快的推理模式 |
| Approve / Decline | 回复 Codex 请求 |
| Fork | 将会话分支到空闲槽位 |
| Review | 请求 Codex 检查当前修改 |
| DEV | 启动或停止开发服务器 |

建议从 Agent 1 开始。旋转旋钮可切换 Codex、Prompts 和 Tools 图层；Touch 也可将同一图层选择器前进一步。

## 隔离式 Agent Manager

Agent 1 保留为主协调器。输入任务后，Agent Manager 会从 Agent 2–6 中自动选择空闲 Worker，为其创建独立的 Git worktree 和分支，并在其中启动 Codex。也可以手动指定 Worker，或在合并队列中设置先行任务。Worker 会话消失时只会安全地自动重启一次；再次失败则停下等待检查。系统还会阻止文件重叠、dirty、冲突或顺序错误的合并，并可恢复丢失的 worktree。

## 自定义 Provider

`Responses API · Codex Agent` 需要兼容 OpenAI Responses API 的 Provider 或代理。仅支持 Chat Completions 的服务（包括 DeepSeek 公共 API）需要 Responses 兼容代理，才能保留 Codex 的沙箱、审批和 Agent 会话能力。

## 开发与测试

```bash
pnpm landing:dev
pnpm landing:build
pnpm test:safe
pnpm test:controls
pnpm test:providers
pnpm test:coordinator
pnpm test:coordinator:stress
```

本项目采用 MIT 许可证发布。

如果 Agent Micro 对你有帮助，欢迎在 [GitHub 点 ⭐ Star](https://github.com/lumpenop/agent-micro)，这会帮助项目继续发展。

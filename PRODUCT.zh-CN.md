# Agent Micro 使用指南

Agent Micro 是 macOS 上用于控制 Codex CLI 的小型浮动控制器。Codex 在终端中运行，常用操作可以直接在控制器上完成。

语言： [한국어](PRODUCT.md) · [English](PRODUCT.en.md) · [日本語](PRODUCT.ja.md)

## 先了解三者的区别

- **Agent Micro**：控制器。
- **Codex CLI**：读取和修改代码的 AI 工具。
- **终端应用**：显示 CLI 会话的窗口。

连接 Codex 并选择项目文件夹后，Agent Micro 才能开始有实际作用。

## 首次启动

首次启动卡片会引导你完成三个步骤：使用 ChatGPT 连接 Codex、选择项目文件夹、启动 Agent 1。完成后，在 Codex 终端中输入任务，并使用 Agent Micro 处理批准、审查和会话控制。

## 槽位与操作

Agent 1 会打开第一个会话。Agent 2–6 用于并行工作，并可以打开额外的终端窗格。建议先从 Agent 1 开始，其他槽位都是可选的。

主要操作包括 Fast、Approve、Decline、Fork、Review 和 DEV。Fork 需要空闲槽位；DEV 只有在项目存在可运行的开发设置时才可用。

旋钮用于调整推理强度，Touch 用于切换 Codex、Prompts 和 Tools 图层。这些属于高级操作，可以稍后再使用。

## 权限与问题排查

控制终端焦点和分屏需要辅助功能权限。如果按钮没有反应，请检查项目文件夹、Codex 连接和 macOS 权限，然后重启 Agent Micro 和终端。

模型、沙盒、批准策略、MCP、Skills 和 Agent 配置等高级选项都在 Settings 中。

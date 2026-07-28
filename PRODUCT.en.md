# Agent Micro User Guide

Agent Micro is a small floating controller for Codex CLI on macOS. It keeps common actions close while Codex runs in a terminal.

Languages: [한국어](PRODUCT.md) · [简体中文](PRODUCT.zh-CN.md) · [日本語](PRODUCT.ja.md)

## Important distinction

- **Agent Micro** is the controller.
- **Codex CLI** reads and changes code.
- **Your terminal app** displays the CLI session.

Agent Micro does not start useful AI work until Codex is connected and a project folder is selected.

## First launch

The first-run card guides you through three steps: connect Codex with ChatGPT, choose the project folder, then start Agent 1. After that, type your task in the Codex terminal and use Agent Micro for approvals, reviews, and session controls.

## Slots and controls

Agent 1 opens the first session. Agents 2–6 can be used for parallel work and open additional terminal panes. Start with Agent 1; the other slots are optional.

The main actions are Fast, Approve, Decline, Fork, Review, and DEV. Fork needs an empty slot. DEV only works when the selected project has a runnable development setup.

The dial changes reasoning intensity. Touch cycles the Codex, Prompts, and Tools layers. These are optional power-user controls.

## Permissions and troubleshooting

Terminal focus and splitting require Accessibility permission. If a button does nothing, verify the selected project folder, the Codex connection, and macOS permissions, then restart Agent Micro and the terminal.

Advanced options such as models, sandbox, approval policy, MCP, Skills, and agent profiles are available from Settings.

# Contributing to Agent Micro

Thanks for your interest in Agent Micro. Contributions are welcome, including bug fixes, documentation, translations, accessibility improvements, and platform work.

## Before you start

Please search existing Issues and pull requests before opening a new one. For larger changes, open an Issue first so the direction can be discussed before code is written.

Small, focused pull requests are easiest to review. If you are not sure where to begin, look for Issues labeled `good first issue` or `help wanted`.

## Development setup

Agent Micro currently targets macOS. Terminal focus, splitting, global shortcuts, and local dictation use macOS-specific APIs.

Requirements:

- macOS
- Node.js
- pnpm 11.8 or newer
- A terminal app
- A Codex CLI login for live integration checks

```bash
git clone https://github.com/lumpenop/agent-keyboard.git
cd agent-keyboard
pnpm install
pnpm start
```

## Checks before opening a PR

Run the safe smoke test and the landing page build:

```bash
pnpm test:safe
pnpm landing:build
```

For a macOS Apple Silicon app build:

```bash
pnpm dist:mac
```

Do not run live smoke actions unless you understand their side effects. Some checks open terminal windows or send real prompts to Codex.

## Pull requests

Please include:

- A short description of what changed and why
- Screenshots or a short recording for UI changes
- Tests or manual verification steps
- Any platform, permission, or migration concerns
- Documentation updates when user-facing behavior changes

Keep unrelated refactors out of the same PR. Reviewers should be able to understand the change from the diff and the PR description.

## Commit messages

Use a short, imperative subject. Examples:

```text
Add first-run onboarding card
Fix terminal slot detection
Update Japanese setup guide
```

## Areas that need help

- Windows Terminal and PowerShell support
- Linux terminal support
- macOS version compatibility
- Accessibility and keyboard navigation
- Translations and onboarding copy
- Automated UI and end-to-end tests

See [ROADMAP.md](ROADMAP.md) for planned work.

## Code of conduct

By participating, you agree to follow the project [Code of Conduct](CODE_OF_CONDUCT.md).

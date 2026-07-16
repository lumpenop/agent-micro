# Agent Micro (Electron)

Work Louder × OpenAI **Codex Micro** 스타일 플로팅 맥로패드.

Codex / Claude / Cursor / Gemini 중 하나를 골라 에이전트 상태·승인·전송·reasoning을 제어합니다.

## Run (pnpm)

```bash
pnpm install   # Electron + @openai/codex + @cursor/sdk
pnpm start
```

단축키: `⌘⇧M` — 창 숨기기/보이기

- 초록 점 = 연결됨
- 노란 점 = demo fallback

## 에이전트 선택

첫 실행 시 **에이전트 선택** 패널이 뜹니다. 이후에도:

| 조작 | 동작 |
|------|------|
| **↻** 길게 누르기 | 프로바이더 피커 |
| **↻** / 제목 옆 **점** | 현재 프로바이더 연결 |
| Shift + 점 | 강제 로그인 |

| Provider | 설치 | 로그인 |
|----------|------|--------|
| **Codex** | `pnpm install` (`@openai/codex`) | Connect → ChatGPT 브라우저 로그인 |
| **Claude** | [Claude Code CLI](https://claude.ai/download) | `claude` 로그인 / Connect |
| **Cursor** | `@cursor/sdk` (pnpm에 포함) | 환경변수 `CURSOR_API_KEY` |
| **Gemini** | `gemini` CLI (`gemini --acp`) | `gemini` 로그인 |

ChatGPT 단독 옵션은 없습니다 — Codex가 ChatGPT 계정으로 연결됩니다.

## macOS 권한

조이스틱 데스크톱 단축키·마이크 음성 인식을 쓰려면:

1. **마이크** — 시스템 설정 → 개인정보 보호 → 마이크 → Agent Micro / Electron 허용
2. **손쉬운 사용(Accessibility)** — 시스템 설정 → 개인정보 보호 → 손쉬운 사용 → Electron 허용

## Controls

| Control | Behavior |
|--------|----------|
| Agent ×6 | 탭 = 전환 · 더블탭 = 에이전트 앱 포커스 |
| ⚡ Fast | reasoning → minimal |
| ✓ / ✕ | Approve / Decline |
| Fork | `thread/fork` (Codex) |
| Mic | 홀드 = PTT · 더블탭 = hands-free |
| Send | Continue · 더블탭 = new chat |
| Dial | reasoning effort |
| Joystick | 레이어에 따라 다름 |
| Touch | Core → Skills → Desktop |

### Layers (Touch)

| Layer | Joy ↑ | Joy → | Joy ↓ | Joy ← |
|-------|-------|-------|-------|-------|
| Core (provider) | Plan | history → | sidebar | history ← |
| Skills | review PR | debug | docs | refactor |
| Desktop | composer | new chat | sidebar | history ← |

## Architecture

- [`src/providers/`](src/providers/) — Codex / Claude / Cursor / Gemini bridges
- 공통 IPC (`codex:*`) → 활성 bridge로 위임
- 선택값은 Electron `userData/provider.json` 에 저장

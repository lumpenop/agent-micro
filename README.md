# Agent Micro (Electron)

Work Louder × OpenAI **Codex Micro** 스타일 플로팅 맥로패드.

**Codex CLI 전용**입니다. Connect = `app-server` · 키/조이스틱/마이크 모두 CLI로 전송합니다.  
연결 후 Whisper용 **API 키(`sk-…`)** 설정을 안내합니다 (상단 🎙).

나중에 “어떤 에이전트를 쓸지” 고르는 UI가 필요하면 그린필드로 붙이세요 (`src/providers/create-bridge.js` 주석 참고).

### 음성 (Mic)

**Codex Connect** 때 로그인·연결 다음 단계로 마이크용 Platform API 키(`sk-…`) 설정을 띄웁니다.  
저장하면 Whisper로 패드에서 바로 인식 → Codex 전송. **나중에**를 누르면 Codex 앱 받아쓰기로 임시 사용합니다.

```bash
# 또는 프로젝트 루트 .env / 환경변수
OPENAI_API_KEY=sk-...
pnpm start
```

## Run (pnpm)

```bash
pnpm install   # Electron + @openai/codex
pnpm start
```

단축키: `⌘⇧M` — 창 숨기기/보이기 (전역)  
패드 단축키(**⇧QWERDF · ⇧1–6 · ⇧화살표 · ⇧Tab**)는 패드 창 또는 이 패드로 연 CLI 터미널에서 동작합니다.

- 초록 점 = Codex 연결됨
- 노란 점 = demo fallback

## Codex CLI 연결

앱 안 **?** = 사용 설명서 · **키보드** 아이콘 = 키 맵핑.

| 조작 | 동작 |
|------|------|
| **↻** / 제목 옆 **점** | CLI Connect / Reconnect (`app-server`) |
| Shift + 점 | Codex 강제 로그인 (브라우저) |
| **🎙** | API 키(`sk-…`) · Whisper |
| **⇧Q W E R D F** | Fast · Approve · Decline · Fork · Mic · Send |
| **⇧Tab** | Touch · 레이어 전환 |
| **⇧↑ ↓ ← →** | 조이스틱 (현재 레이어 액션) |
| **⇧1–6** | 투명 에이전트 키 (좌상단→우하단) |

종료: **⌘⇧Q**

설치: `pnpm install` (`@openai/codex`) · 로그인: Connect → ChatGPT 브라우저 로그인

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
| Fork | `thread/fork` → 다음 빈 슬롯 + CLI 스플릿 (UI는 6/6일 때만 비활성) |
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

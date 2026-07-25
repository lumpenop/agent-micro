# Agent Micro (Electron)

**Agent Micro** — Codex CLI용 플로팅 맥로패드.

Connect = `app-server` · 키/조이스틱 액션을 CLI로 전송합니다.
Codex CLI는 기존 설치를 우선 사용하고, 없으면 앱 전용 폴더로 다운로드합니다.

나중에 “어떤 에이전트를 쓸지” 고르는 UI가 필요하면 그린필드로 붙이세요 (`src/providers/create-bridge.js` 주석 참고).

### Review

Review 키캡 또는 `Mod+D` → 선택한 Agent에 현재 변경 사항 리뷰 요청을 전송합니다.

## Run (pnpm)

```bash
pnpm install   # 개발 의존성 설치
pnpm start
```

이 프로젝트는 MIT 라이선스로 공개 배포됩니다. 별도의 체험 기간이나 라이선스 키가 필요하지 않습니다.

랜딩 빌드: `AGENT_MICRO_DOWNLOAD_URL=https://... pnpm landing:build`

로컬 확인: `pnpm landing:dev`

단축키: `⌘⇧M` — 창 숨기기/보이기 (전역)  
패드 단축키(기본 **⌘QWERDF · ⌘1–6 · ⌘화살표 · ⌘Tab**)는 패드 창 또는 이 패드로 연 CLI 터미널에서 동작합니다.  
수정키는 키 맵핑에서 **⌘ / ⌥ / ⌃ / ⇪** 중 선택 (기본 ⌘).

- 초록 점 = Codex 연결됨
- 노란 점 = demo fallback

## Codex CLI 연결

앱 안 **?** = 사용 설명서 · **키보드** 아이콘 = 키 맵핑.

| 조작 | 동작 |
|------|------|
| **↻** / 제목 옆 **점** | CLI Connect / Reconnect (`app-server`) |
| Shift + 점 | Codex 강제 로그인 (브라우저) |
| **Mod+Q W E R D F** | Fast · Approve · Decline · Fork · Review · DEV (기본 Mod=⌘) |
| **Mod+Tab** | Touch · 레이어 전환 |
| **Mod+↑ ↓ ← →** | 조이스틱 (현재 레이어 액션) |
| **Mod+1–6** | Agent 1 = 새 창 · 2–6 = 직전 창에서 순서대로 스플릿 (1→2→3…, 앞 번호 없으면 무시) |

종료: **⌘⇧Q**

사용자 설치: Provider 선택 → 필요한 CLI 자동 다운로드 → 브라우저 로그인

## macOS 권한

조이스틱 데스크톱 단축키·마이크 음성 인식을 쓰려면:

1. **손쉬운 사용(Accessibility)** — 시스템 설정 → 개인정보 보호 → 손쉬운 사용 → Electron 허용

## Controls

| Control | Behavior |
|--------|----------|
| Agent ×6 | 1 = 새 CLI 창 · 2–6 = 직전 에이전트에서 순차 스플릿 (1→2→3…) · 이미 있으면 포커스 |
| ⚡ Fast | reasoning → minimal |
| ✓ / ✕ | Approve / Decline |
| Fork | 소스 세션 fork → 다음 빈 슬롯에 `codex fork`/`resume` CLI 스플릿 (UI는 6/6일 때만 비활성) |
| Review | 선택한 Agent에 현재 변경 사항 리뷰 요청 |
| DEV (formerly Send) | 현재 선택 에이전트의 작업 폴더 개발 서버 시작·종료 |
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

- [`src/providers/`](src/providers/) — Codex bridge
- 공통 IPC (`codex:*`) → 활성 bridge로 위임
- 선택값은 Electron `userData/provider.json` 에 저장

## Codex Control Center

- 설정: 모델·추론·성격·검색·권한·작업 폴더·멀티에이전트·역할·리소스·Hooks
- Agent rules: 전역 → 프로젝트 `.agent-micro/rules.json` → 역할 → Agent 1–6 슬롯 규칙을 합성. 슬롯별 이름·모델·reasoning·작업 폴더·sandbox·승인·자동 Continue·선호 Skills를 재정의
- 안전: 저장 전 자동 백업, 복원 전 재백업, 위험 권한 조합 경고
- MCP 탭: 서버 탐색, 활성화, 타임아웃, HTTP/stdio 추가, OAuth, 검사, 삭제
- Skills 탭: 앱 안에서 개인 스킬 생성·조회·수정·삭제, 시스템·플러그인 스킬 목록과 플러그인 설정 진단
- 3개 레이어: `Codex → Prompts → Tools` 순환. Tools에서 ↑ `gpt-5.6-terra`(Light) / `gpt-5.6-sol`(Deep) 즉시 전환, ↓ 선택 에이전트 작업 폴더의 `dev` 서버 시작·종료
- Info Continue: 수동 전송 및 설정 시간 후 자동 Continue. 기본값은 꺼짐·30초·최대 1회이며 승인·입력 대기·오류에서는 자동 실행하지 않음
- Info Project: 선택한 Agent CLI의 실제 작업 폴더에서 `package.json.name`을 우선 표시하고, 없으면 폴더명을 표시. 전체 경로는 툴팁으로 확인
- 아이콘 선택기: 로컬 아이콘·사용자 SVG/PNG·Iconify 온라인 AI 에이전트 검색
- Info: 선택한 에이전트의 실제 작업 폴더 표시

Apple Silicon 개발 앱은 `pnpm dist:mac`, 설치용 DMG는 `pnpm dist:dmg`로 빌드합니다.
Apple Developer 인증서를 설정하지 않은 로컬 산출물은 서명·공증되지 않습니다.

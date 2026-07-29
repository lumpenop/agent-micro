# Agent Micro

Codex CLI를 키보드와 작은 플로팅 맥로패드로 조작하는 macOS 앱입니다.

이 문서는 처음 설치하는 사람도 앱을 실행하고 기본 기능을 사용할 수 있도록 작성했습니다.

문서 언어: [English](README.en.md) · [简体中文](README.zh-CN.md) · [日本語](README.ja.md)

기여하고 싶다면 [CONTRIBUTING.md](CONTRIBUTING.md)를 먼저 확인해 주세요. 현재 작업 방향은 [ROADMAP.md](ROADMAP.md)에서 볼 수 있습니다.

## Agent Micro가 하는 일

Agent Micro는 Codex CLI의 명령을 대신 입력해 주는 리모컨에 가깝습니다.

- 최대 6개의 Codex CLI 세션을 슬롯으로 관리합니다.
- Approve, Decline, Fork, Review 같은 동작을 버튼과 단축키로 실행합니다.
- 선택한 프로젝트의 개발 서버를 시작하고 종료합니다.
- 조이스틱과 Touch 레이어로 Plan, history, sidebar, 새 채팅 등을 실행합니다.
- Codex의 모델·추론 강도·작업 폴더·권한 관련 설정을 앱 안에서 관리합니다.
- 개인 Skills/MCP 설정을 지원합니다.

Agent Micro 자체는 AI 모델을 제공하지 않습니다. 실제 작업과 답변은 연결된 Codex CLI가 처리합니다.

## 빠른 시작

### 1. 준비물

개발 버전을 실행하려면 다음이 필요합니다.

- macOS
- Node.js
- pnpm
- 터미널 앱(Terminal, iTerm2, Ghostty 등)
- Codex CLI를 사용할 수 있는 ChatGPT 로그인

배포된 `.app`을 사용하는 경우에는 Node.js와 pnpm이 필요하지 않습니다. 소스 코드로 실행할 때만 필요합니다.

### 2. 저장소 받기

터미널을 열고 저장소를 내려받습니다.

```bash
git clone https://github.com/lumpenop/agent-micro.git
cd agent-micro
```

이미 저장소를 받은 경우에는 `cd`로 프로젝트 폴더에 들어갑니다. 현재 폴더에 `package.json`과 `src` 폴더가 보여야 합니다.

### 3. 의존성 설치

```bash
pnpm install
```

`pnpm` 명령을 찾을 수 없다는 메시지가 나오면 먼저 pnpm을 설치합니다.

```bash
corepack enable
corepack prepare pnpm@11.8.0 --activate
```

### 4. 앱 실행

```bash
pnpm start
```

앱 창이 열리면 설치가 완료된 것입니다. 개발 중에는 터미널에 앱 로그가 표시될 수 있습니다.

### 5. 첫 실행: 세 단계

앱을 처음 열면 다음 순서가 표시됩니다.

1. **Codex 연결**: ChatGPT 계정으로 로그인합니다.
2. **프로젝트 선택**: Codex가 작업할 폴더를 선택합니다.
3. **Agent 시작**: `Start`를 눌러 첫 번째 Codex 세션을 엽니다.

같은 Mac에서 Codex CLI에 이미 로그인했다면 1단계가 자동으로 완료될 수 있습니다. 작업 폴더와 고급 기능은 Settings에서 바꿀 수 있습니다.

이 프로젝트는 MIT 라이선스로 공개된 오픈소스 소프트웨어입니다. 체험 기간, 구매 절차, 라이선스 키는 없습니다.

도움이 되었다면 [GitHub에서 ⭐ Star](https://github.com/lumpenop/agent-micro)를 눌러주세요. 프로젝트를 계속 발전시키는 데 큰 도움이 됩니다.

## macOS 권한 설정

일부 기능은 macOS 권한이 필요합니다.

### 손쉬운 사용 권한

CLI 창에 포커스를 맞추거나 터미널을 분할하고 전역 단축키를 사용하려면 허용해야 합니다.

1. **시스템 설정**을 엽니다.
2. **개인정보 보호 및 보안 → 손쉬운 사용**으로 이동합니다.
3. Agent Micro 또는 Electron을 목록에 추가하고 켭니다.
4. 앱을 완전히 종료한 뒤 다시 실행합니다.

## 기본 사용법

### 에이전트 슬롯 열기

앱의 `1`부터 `6`까지 슬롯은 각각 하나의 CLI 세션을 가리킵니다.

| 슬롯 | 동작 |
|------|------|
| 1 | 새 터미널 창에서 Codex 시작 |
| 2–6 | 직전 슬롯의 터미널을 분할해 새 세션 시작 |
| 이미 열린 슬롯 | 해당 터미널 패인으로 포커스 |

보통은 **1번을 먼저 연 다음 2번, 3번 순서로** 여는 것이 가장 안정적입니다. 1번을 열지 않고 2번을 누르면 동작하지 않습니다.

### 하단 버튼

| 버튼 | 기능 |
|------|------|
| ⚡ Fast | 현재 에이전트의 추론 강도를 minimal로 변경 |
| ✓ Approve | Codex가 요청한 작업 승인 |
| ✕ Decline | Codex가 요청한 작업 거절 |
| Fork | 현재 세션을 분기해 다음 빈 슬롯에서 실행 |
| Review | 현재 변경 사항의 코드 리뷰 요청 |
| DEV | 선택한 프로젝트의 개발 서버 시작/종료 |

Fork는 빈 슬롯이 있을 때만 사용할 수 있습니다. 6개 슬롯이 모두 사용 중이면 비활성화됩니다.

### Dial과 Touch

- **Dial**: 돌릴 때마다 `Codex → Prompts → Tools` 레이어를 전환합니다.
- **Touch**: 탭할 때마다 같은 레이어를 한 칸씩 전환합니다.
- **Joystick**: 현재 레이어에 지정된 방향 동작을 실행합니다.

| 레이어 | 위 | 오른쪽 | 아래 | 왼쪽 |
|--------|---|--------|------|------|
| Codex | Plan | 다음 Agent | 새 채팅 | 이전 Agent |
| Prompts | review PR | debug | docs | refactor |
| Tools | 모델 변경 | Continue | 개발 서버 | 도움말 |

키캡을 우클릭하면 아이콘을 바꿀 수 있습니다. 아이콘 선택기의 `+` 버튼으로 개인 SVG/PNG도 추가할 수 있습니다.

### Agent Manager와 격리 작업

Agent 1은 메인 조정용으로 유지합니다. Agent Manager에 작업을 입력하면 Agent 2–6 중 빈 Worker를 자동 선택하고, 해당 Agent만 사용하는 Git worktree와 브랜치를 만든 뒤 Codex CLI를 실행합니다.

- 필요하면 특정 Worker를 직접 고르거나 다른 작업을 선행 병합 조건으로 지정할 수 있습니다.
- 병합 큐가 의존성과 생성 순서를 표시하고, 선행 작업이 끝나기 전 병합을 차단합니다.
- 실행 중인 Worker 창이 사라지면 감지 후 한 번만 자동 재실행하며, 반복 실패는 사용자 확인 상태로 전환합니다.
- 동시에 만드는 작업도 프로젝트별로 직렬화해 Git 메타데이터 충돌을 막습니다.
- 둘 이상의 Agent가 같은 파일을 수정하면 병합 전에 표시하고 차단합니다.
- dirty worktree와 dirty 메인 작업공간은 병합하지 않습니다.
- 실제 Git 충돌은 메인을 변경하기 전에 검사합니다.
- worktree 폴더가 사라져도 브랜치가 남아 있으면 **복구**할 수 있습니다.
- 병합이 실패해도 진행 중인 merge 상태를 메인에 남기지 않습니다.

## 단축키

기본 수정키는 `⌘ Command`이며, 앱의 **키보드 아이콘 → 키 맵핑**에서 변경할 수 있습니다. `Mod`는 현재 선택한 수정키를 뜻합니다.

| 단축키 | 동작 |
|--------|------|
| `⌘⇧M` | 앱 창 숨기기/보이기 |
| `⌘⇧Q` | 앱 종료 |
| `Mod + 1–6` | 에이전트 슬롯 선택/실행 |
| `Mod + Q` | Fast |
| `Mod + W` | Approve |
| `Mod + E` | Decline |
| `Mod + R` | Fork |
| `Mod + D` | Review |
| `Mod + F` | DEV |
| `Mod + Tab` | Touch 레이어 전환 |
| `Mod + ↑ ↓ ← →` | 조이스틱 방향 동작 |

패드 창이나 Agent Micro가 연 CLI 터미널이 앞에 있을 때 패드 단축키가 동작합니다.

## 설정 메뉴

앱의 톱니바퀴 아이콘에서 다음을 설정할 수 있습니다.

- Codex 로그인 및 연결 상태
- Provider와 API 설정
- 모델과 추론 강도
- 작업 폴더
- sandbox, 승인, 타임아웃 등 Codex 설정
- 에이전트별 이름·역할·모델·작업 폴더
- 자동 Continue
- MCP 서버
- 개인 Skills
- 언어와 수정키

설정은 macOS의 Electron 사용자 데이터 폴더와 `~/.codex`에 저장됩니다. 일부 설정은 새로 여는 CLI 창부터 적용됩니다.

### Custom provider 호환성

`Responses API · Codex Agent`는 OpenAI Responses API와 호환되는 provider 또는 proxy용입니다. Codex의 sandbox, 승인, Agent 세션을 그대로 유지하는 대신 `/responses` 프로토콜이 필요합니다.

DeepSeek 공개 API처럼 `/chat/completions`만 제공하는 API는 이 모드에 직접 연결할 수 없습니다. 그런 provider를 Codex Agent로 사용하려면 Responses API를 제공하는 호환 proxy가 필요합니다.

## 랜딩 페이지 개발

랜딩 페이지는 `apps/landing`에 있습니다.

개발 서버 실행:

```bash
pnpm landing:dev
```

정적 파일 빌드:

```bash
pnpm landing:build
```

다운로드 버튼에 표시할 앱 주소를 지정하려면:

```bash
AGENT_MICRO_DOWNLOAD_URL=https://example.com/Agent-Micro.dmg pnpm landing:build
```

빌드 결과는 `apps/landing/dist`에 생성됩니다. Vercel에서는 이 폴더를 출력 디렉터리로 사용합니다.

## macOS 앱 빌드

Apple Silicon용 개발 산출물을 만들려면:

```bash
pnpm dist:mac
```

설치용 DMG를 만들려면:

```bash
pnpm dist:dmg
```

로컬에서 만든 앱은 Apple Developer 인증서가 없으면 서명·공증되지 않습니다. macOS에서 처음 열 때 보안 경고가 나타날 수 있습니다.

## 테스트

안전한 기능 테스트는 다음 명령으로 실행합니다.

```bash
pnpm test:safe
pnpm test:controls
pnpm test:providers
pnpm test:providers:codex
pnpm test:coordinator
pnpm test:coordinator:stress
```

실제 터미널에 입력하거나 창을 여는 테스트는 부작용이 있으므로 별도 환경 변수 없이는 실행되지 않습니다.

## 문제 해결

### 앱 창은 열리지만 Codex가 연결되지 않음

1. Codex CLI가 설치되어 있는지 확인합니다.
2. 앱의 `↻` 버튼으로 다시 연결합니다.
3. Shift를 누른 채 제목 옆 점을 눌러 강제 로그인을 실행합니다.
4. 손쉬운 사용 권한을 확인하고 앱을 다시 시작합니다.

### 터미널 분할이 동작하지 않음

손쉬운 사용 권한이 필요합니다. 권한을 켠 뒤 Agent Micro와 터미널 앱을 모두 종료하고 다시 실행하세요.

### `pnpm install` 중 Electron 관련 메시지가 나옴

의존성 설치가 끝난 뒤 아래 명령을 한 번 실행해 보세요.

```bash
pnpm rebuild electron
```

### 로그 확인

앱을 터미널에서 실행하면 오류 로그를 확인할 수 있습니다.

```bash
pnpm start
```

## 프로젝트 구조

```text
src/
  main.js                 Electron 메인 프로세스와 IPC
  preload.js              렌더러에 노출하는 안전한 API
  app.mjs                 화면 동작과 이벤트 처리
  index.html              앱 화면
  styles.css              앱 스타일
  providers/              Codex/API 연결 브리지
  *.mjs, *.js             설정·아이콘·도구 모듈
apps/landing/             정적 랜딩 페이지
scripts/                  설치·테스트·빌드 보조 스크립트
LICENSE                   MIT 라이선스
THIRD_PARTY_NOTICES.md    포함된 오픈소스 고지
```

## 기여하기

1. 저장소를 Fork합니다.
2. 기능별 브랜치를 만듭니다.
3. 변경 후 `pnpm test:safe`를 실행합니다.
4. 변경 목적과 테스트 결과를 Pull Request에 적습니다.

기존 사용자 설정이나 사용자가 직접 만든 `AGENTS.md` 파일을 덮어쓰는 변경은 피해주세요.

## 라이선스

Agent Micro는 [MIT License](LICENSE)로 배포됩니다. 포함된 외부 프로젝트의 조건은 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)를 확인하세요.

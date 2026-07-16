# Agent Micro (Electron)

Work Louder × OpenAI **Codex Micro** 스타일 플로팅 맥로패드.

Codex CLI `app-server`에 붙어 에이전트 상태·승인·전송·reasoning을 제어합니다.

## Run

```bash
npm install
npm start
```

단축키: `⌘⇧M` — 창 숨기기/보이기

- 초록 점 = Codex 연결
- 노란 점 = demo fallback

## macOS 권한

조이스틱 데스크톱 단축키·마이크 음성 인식을 쓰려면:

1. **마이크** — 시스템 설정 → 개인정보 보호 → 마이크 → Agent Micro / Electron 허용
2. **손쉬운 사용(Accessibility)** — 시스템 설정 → 개인정보 보호 → 손쉬운 사용 → Electron 허용  
   (ChatGPT/Codex로 ⌘[/]//B 키 주입)

## Controls

| Control | Behavior |
|--------|----------|
| Agent ×6 | 탭 = 전환 · 더블탭 = Codex 앱 포커스 |
| ⚡ Fast | reasoning → minimal |
| ✓ / ✕ | Approve / Decline |
| Fork | `thread/fork` |
| Mic | 홀드 = PTT · 더블탭 = hands-free · Web Speech → `turn/start` |
| Send | Continue · 더블탭 = new chat · 아이콘별 프롬프트 |
| Dial | reasoning effort |
| Joystick | **레이어에 따라 다름** (아래) |
| Touch | 레이어 순환: Codex → Skills → Desktop |

### Layers (Touch)

| Layer | Joy ↑ | Joy → | Joy ↓ | Joy ← |
|-------|-------|-------|-------|-------|
| Codex | Plan | history → | sidebar | history ← |
| Skills | review PR | debug | docs | refactor |
| Desktop | composer | new chat | sidebar | history ← |

### Icons

키캡 아이콘을 바꾸면(우클릭) 해당 키 동작이 아이콘 의미에 가깝게 바뀝니다.  
예: Send에 Claude → Claude 스타일 프롬프트, Fast에 rocket → ship 스킬 등.

## Codex link

- `@openai/codex` → `app-server --stdio` (실패 시 proxy → demo)
- Approve / Decline / Fork / Send / Agent / reasoning / skills

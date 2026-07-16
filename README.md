# Codex Micro (Electron)

Work Louder × OpenAI **Codex Micro** 데스크탑 레플리카.

투명 플로팅 윈도우 + 실물형 키캡 UI. Codex CLI `app-server`에 붙어 에이전트 상태를 반영합니다.

## Run

```bash
npm install
npm start
```

단축키: `⌘⇧M` — 창 숨기기/보이기

상단 초록 점 = Codex 연결, 노란 점 = demo fallback.

## Codex link

- `@openai/codex` 네이티브 바이너리로 `app-server --stdio` 핸드셰이크
- 실패 시 `app-server proxy` → 그래도 안 되면 demo mode
- Approve / Decline / Fork / Send / Agent 전환이 bridge IPC로 전달
- Agent 더블탭 시 ChatGPT/Codex 앱(`com.openai.codex`) 포커스

## Controls

| Control | Behavior |
|--------|----------|
| Agent Keys (6) | 탭 = 태스크 전환 / 350ms 내 더블탭 = ChatGPT focus |
| ⚡ Fast | Fast mode 토글 |
| ✓ / ✕ | Approve / Decline (app-server approval) |
| Fork | `thread/fork` |
| Mic | 홀드 = PTT / 더블탭 = hands-free → send |
| Send | `turn/start` |
| Dial | reasoning effort |
| Joystick | ↑ Plan · → forward · ↓ sidebar · ← back |
| Touch | 탭 = layer / 3초 홀드 = pairing |

## Status lights

White idle · Blue thinking · Green complete · Amber needs input · Red error

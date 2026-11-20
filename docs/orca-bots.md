# Orca Bots 연동 (1단계 확인과 설계)

Orca 1.4.265의 Orca Bots를 orca-helm(Grok Bot 연동)에 붙일 수 있는지 확인한 결과와 설계입니다. 2026-11-20 이 PC(Windows, Orca 1.4.265)에서 확인했습니다.

## 1. 확인 결과

### 1.1 버전과 CLI

- `orca --version` 은 `1.4.265` 입니다.
- `orca --help` 에 `Bots` 절이 있습니다: `bot reply`, `bot connectors`, `slack …`, `gmail …`, `calendar …`, `drive …` 등.
- `orca bot` 하위 명령은 `create`(owner가 카드에서 수락해야 생성), `list`, `chats`, `reply`, `connectors`, `import …`, `tools …`, `google-setup …`, `composio …` 입니다.
- 도움말과 `agent-context` 스키마에 나오지 않는 숨은 명령 `bot item add|set|comment|done|cancel|link|list|show` 가 있습니다. 앱 코드(`out/cli/specs/bot-items.js`)에 `hidden: true` 로 있고, 주석은 "봇 preamble이 가르칠 때까지 숨김"입니다.
- 봇은 `~/.orca/bots/<폴더>/` 에 삽니다(`bot.json` 의 `id`·`name`, `SOUL.md`, `memory/`). 지금 이 PC에는 봇 `쿠어` 하나가 있습니다.
- 봇 채팅은 `orca agent list` 에 `kind: chat` 으로 나옵니다. `paneKey` 는 `structured-agent-session-<id>:…`, `worktreeId` 는 `folder:<id>`, workspace 이름은 봇 이름입니다.

### 1.2 플러그인 API

- 이벤트(`orca plugin types` 로 만든 타입): `workspace.created`, `workspace.removed`, `workspace.changed`, `agent.status.changed`, `editor.typography.changed`. 봇 전용 이벤트는 없습니다.
- 훅: `terminal.send`, `workspace.create.before/after`, `agent.launch.before`, `agent.prompt.before`, `agent.tool.before/after`, `editor.save.before`. 봇 전용 훅도 없습니다.

### 1.3 "Needs you"는 두 가지

| 종류 | 무엇 | Orca 화면 |
| --- | --- | --- |
| 채팅 상태 | 봇 채팅 에이전트가 승인(permission)이나 답을 기다림. 앱 코드 `agent-transitions.js` 가 hook 상태 `blocked`·`waiting` 을 phase `needs-you` 로 바꿉니다. | "Permission needed", "Permission · <도구>", "Waiting for you" |
| 봇 item | 봇이 `orca bot item set <n> --status needs-you --ask "<질문>" --option "<선택지>"…` 로 owner에게 남긴 결정 질문. 봇은 이걸 걸고 턴을 끝냅니다. | Needs you 항목 카드. owner가 Orca에서 답하면 "기록된 답"이 봇 메일로 가고 item이 In progress로 돌아갑니다. |

이 밖에 로그인·커넥터 같은 설정 요청도 Needs you에 나오지만, 연동 대상은 아닙니다.

### 1.4 훅으로 들어오는가

- **채팅 상태: 들어옵니다(3절 실측).** 앱 코드도 같은 결론입니다. 플러그인에 `agent.status.changed` 를 내는 경로(`subscribeEnrichedStatus` → 매핑 함수)는 `restoredUnconfirmed` 만 거릅니다. 같은 상태 스트림을 쓰는 시스템 알림 등 다른 구독자는 `structuredHost`(채팅 세션)를 명시적으로 거릅니다. 즉 채팅 세션도 같은 스트림에 실리고, 플러그인 경로는 그것을 거르지 않습니다. 이때 이벤트의 `workspaceId` 는 `folder:<id>` 이고, `terminalId` 는 없습니다(터미널이 아님).
- **봇 item: 이벤트로는 들어오지 않습니다(읽어서 잡음, 3절 실측).** item 상태 변경은 플러그인 이벤트가 아닙니다. 다만 봇은 needs-you를 건 뒤 턴을 끝내므로, 그 채팅의 `agent.status.changed`(`done`)가 옵니다. 그때 `orca bot item list --bot <이름> --status needs-you --json` 으로 읽으면 됩니다. 봇 채팅 밖(일반 셸, 플러그인 워커)에서도 `--bot` 으로 읽히는 것을 확인했습니다. 결과에는 `number`, `title`, `status`, `chat.id`, `question`(`eventId`, `text`, `ask.questions[]`)이 있습니다.
- **orca-helm-ask 질문 훅(`tourbut/prompt-blocked` 브랜치, 아직 main에 없음): 봇 채팅에서는 동작하지 않습니다(3절 실측).** Claude 프로필 다섯 곳 모두에 `orca-helm-ask@orca-helm` 이 설치돼 있지만, 봇이 `AskUserQuestion` 카드를 띄워도 훅이 쓰는 `~/.orca-helm/ask/` 파일이 생기지 않았습니다. 훅이 아예 돌지 않았는지, `ORCA_WORKSPACE_ID` 가 없어 바로 물러났는지는 구분하지 못했습니다. 어느 쪽이든 봇 채팅의 질문 카드는 이 경로로 넘어오지 않습니다.
- 대기 중인 질문 카드의 글은 `orca agent read <채팅 세션 id> --limit 3 --json` 에서 `{"kind":"question","text":"…","pending":true}` 로 읽힙니다. 선택지는 나오지 않습니다. 채팅 세션 id는 이벤트 `paneKey` 의 `structured-agent-session-<id>:` 부분입니다.

### 1.5 나가는 쪽: orca-helm에서 봇에게 일 넣기

| 방법 | 로그인 | 비고 |
| --- | --- | --- |
| `orca orchestration send --to bot:<이름> --type handoff\|question\|status [--chat <id>\|new] [--item <n>]` | 필요 없음(로컬) | `handoff` 는 일을 맡김, `question` 은 메일로 답함, `status` 는 정보만. `--item <n>` 은 그 item을 가진 채팅으로 갑니다. helm-probe로 실측했습니다(3절). 봇의 답은 보낸 쪽 메일함으로 옵니다(Orca 터미널에서 보내면 그 터미널의 `orca orchestration check`). |
| 봇 채팅(Orca UI, `@봇`) | 필요 없음 | 사람용 |
| 스케줄 automation | 필요 없음 | 봇에게 채팅으로 설정 |
| 봇 웹훅 | **Orca 클라우드 로그인 필요** | 채팅에서 봇에게 만들게 하고 카드의 Copy URL로 복사. URL 자체가 비밀번호이며 서명 비밀값을 더할 수 있음. 로그아웃하면 이벤트가 멈춤. |
| Slack, GitHub, Linear | **로그인 필요** | Orca Cloud 경유 |

- owner의 "기록된 답"을 남기는 CLI는 없습니다. CLI 메일은 봇에게 전달되지만 Orca 카드에는 owner의 답으로 기록되지 않습니다(item 도움말: owner의 일반 코멘트도 기록된 답이 아님). 실측에서는 봇이 메일을 읽고 답을 적은 뒤 item을 Done으로 옮겼습니다.
- 채팅 승인(permission)이나 채팅 안의 `AskUserQuestion` 카드를 CLI로 답하는 경로는 찾지 못했습니다. 카드가 떠 있는 동안 턴이 멈춰 있으므로 메일도 그 뒤에야 읽힙니다. 이것들은 Orca 화면(또는 모바일)에서 답해야 합니다.

## 2. 설계

```text
 Orca 봇 채팅 ──(agent.status.changed, folder:<id>)──▶ grokbot-notify ──▶ Grok Bot 루틴
      ▲                    │ 채팅 상태 → 기존 agent 알림(A)
      │                    └ 멈출 때 bot item list → bot.needs_you(B)
      │
      └──── orca-helm bot <이름> [--item n] ◀──── Grok Bot (PC 셸)
              (orca orchestration send --to bot:<이름>)
```

### 2.1 라우팅: 봇 이름을 워크스페이스로

봇 채팅의 workspace는 봇 이름의 폴더 워크스페이스이고 경로는 `~/.orca/bots/<폴더>` 입니다. 기존 `matchesWorkspace` 가 이름으로 맞추므로 새 설정이 필요 없습니다. `Routes` 줄의 워크스페이스 칸에 봇 이름을 넣으면 그 Grok Bot이 그 Orca 봇을 맡습니다.

```text
풀로 | orca-helm,쿠어 | <루틴 URL> | <Authorization>
```

워크스페이스 칸이 빈 줄(전체)은 봇 채팅도 받습니다.

### 2.2 들어오는 쪽

- **A. 채팅 상태(코드 변경 없음):** 기존 `agent.status.changed` 전달이 그대로 처리합니다. `worktree` 는 봇 이름, `repo`·`branch`·`tail`·`terminalId` 는 `null` 입니다(채팅은 터미널이 아님). 봇이 카드를 띄우면 `blocked`, 턴이 끝나면 `done (success)` 입니다. Grok Bot은 사람에게 "Orca에서 승인/답 필요"라고 전하기만 합니다.
- **B. 봇 item Needs you(구현함):** 봇 채팅이 `working` 이 아닌 상태로 알려지면, 워커가 `bot.json` 으로 봇을 알아보고 `orca bot item list --bot <이름> --status needs-you` 를 읽습니다. 라우트마다 item 하나를 질문(`question.eventId`) 하나에 한 번씩 `bot.needs_you` 로 보냅니다. 같은 item에 새로 물으면 다시 보내고, 닫힌 item은 잊습니다. 보낸 기록은 FullOps 사건과 같은 저장소 키에 남아 워커가 다시 떠도 유지됩니다. 자유 텍스트의 비밀값은 다른 알림과 같은 규칙으로 가립니다.
- **C. orca-helm-ask:** 봇 채팅에는 걸리지 않습니다(3절). 봇 채팅의 질문 카드는 A의 `blocked` 알림으로만 알 수 있습니다.

`bot.needs_you` 예(실측에서 받은 모양, `text` 는 고친 뒤 형식):

```json
{
  "event": "bot.needs_you",
  "text": "helm-probe #2: needs you - 실측 B: 머지 대상 고르기: 연동 시험용 질문입니다 (어느 브랜치로 머지할까요? [main / dev])",
  "bot": "helm-probe",
  "item": 2,
  "title": "실측 B: 머지 대상 고르기",
  "question": {
    "eventId": "e15",
    "text": "연동 시험용 질문입니다\n\n어느 브랜치로 머지할까요?\n   - main (recommended)\n   - dev: 개발 브랜치",
    "ask": { "context": "연동 시험용 질문입니다", "questions": [{ "prompt": "어느 브랜치로 머지할까요?", "options": [{ "label": "main" }, { "label": "dev", "detail": "개발 브랜치" }], "recommended": 0 }] },
    "answerable": true
  },
  "chat": "<chat id>",
  "reply": "orca-helm bot \"helm-probe\" --item 2 --text <answer>",
  "repo": null, "worktree": "helm-probe", "branch": null, "route": "probe", "host": "<PC 이름>"
}
```

`question.text` 는 Orca가 선택지까지 풀어 쓴 글이라, 한 줄 `text` 에는 `ask.context` 를 씁니다. `recommended` 는 0부터 세는 번호입니다(봇이 쓰는 CLI `--recommended` 는 1부터).

### 2.3 질문 카드 흐름 재사용

Grok Bot 루틴은 `fullops.decision`, `claude.question` 과 같은 방식으로 `bot.needs_you` 를 다룹니다. `text` 한 줄을 사람에게 보여 주고, `question.ask.questions[].options[].label` 을 선택지로 씁니다. 사람이 고르면 `reply` 를 실행합니다.

```powershell
.\orca-helm.ps1 bot 쿠어 --item 3 --text "main으로 머지해 주세요 (성철 답)"
```

이 답은 그 item을 가진 채팅에 `handoff` 메일로 갑니다. 봇은 메일을 읽고 이어서 일합니다. Orca 카드에는 "기록된 답"으로 남지 않으므로, 봇이 item 상태를 직접 옮겨야 카드가 닫힙니다.

### 2.4 나가는 쪽

`orca-helm bot <봇 이름> (--file <f> | --text <t>) [--item <n> | --chat <id|new>] [--type handoff|question|status] [--subject <제목>]`

- 기본 `handoff` 는 Home Chat에 일을 맡깁니다. `--chat new` 는 새 채팅, `--chat <id>` 는 `orca bot chats` 의 그 채팅입니다.
- 제목은 `--subject`, 없으면 본문 첫 줄(80자)이고, `--item` 이면 `Answer on item #<n>` 입니다.
- 결과는 봇 채팅에 남습니다. `orca bot chats --bot <이름> --json` 의 `lastSaid`, `orca bot item list --bot <이름>` 으로 읽습니다.
- 로컬 메일이라 Orca 클라우드 로그인이 필요 없습니다. 웹훅은 Grok Bot이 PC 셸 없이 직접 부를 수 있다는 장점이 있지만, 로그인과 URL 비밀 관리가 필요해 이번에는 쓰지 않았습니다.

## 3. 실측 결과

2026-11-20 테스트 봇 `helm-probe`(owner가 만듦)로 시험했습니다. Grok Bot에 실제로 보내지 않도록 이 브랜치를 개발 플러그인(`local.grokbot-notify`)으로 불러오고, 라우트는 `probe | helm-probe | http://127.0.0.1:47811/probe | …` 하나만 두었습니다(로컬 수신기). 일은 모두 `orca-helm bot helm-probe …` 로 넣었습니다.

| 시험 | 결과 |
| --- | --- |
| 나가는 쪽: `orca-helm bot helm-probe --file …` (handoff) | 됨. 봇이 일을 하고 답을 보낸 터미널 메일함으로 보냄 |
| A: 봇 턴 종료 | 됨. `agent.status.changed` `done (success)`, `workspaceId: folder:…`, `paneKey: structured-agent-session-…`, `terminalId: null` |
| B: 봇이 item #2를 needs-you로 둠 | 처음엔 실패: 워커에서 `orca` 가 `APPDATA is not set …` 로 실패. `runOrca` 를 고친 뒤 다음 턴 종료 때 `bot.needs_you` 1건 도착 |
| B 답: `orca-helm bot helm-probe --item 2 --text …` | 됨. 메일이 item #2의 채팅으로 가고, 봇이 답을 적고 item을 Done으로 옮김 |
| A: 봇이 `AskUserQuestion` 카드를 띄움 | 됨. `agent.status.changed` `blocked` |
| C: 같은 카드에 orca-helm-ask 훅 | 안 됨. 90초 동안 `~/.orca-helm/ask/` 파일이 생기지 않음 |
| A: 권한 모드 "Ask for approval"의 승인 요청 | 시험 안 함. 권한 모드를 CLI로 바꿀 수 없어서. 앱 코드상 같은 `blocked`/`waiting` 경로 |

실측에서 고친 것:

- **`runOrca` 의 APPDATA:** Orca 플러그인 워커는 APPDATA 없이 돌고, Windows의 `orca` 는 그것이 없으면 런타임을 못 찾습니다. 없으면 `<홈>\AppData\Roaming` 을 넣어 부릅니다. FullOps의 `orca orchestration inbox`(escalation·실패 알림)도 같은 함수를 쓰므로, 릴리스된 0.6.0에서도 Windows에서는 이 읽기가 실패했을 가능성이 큽니다(설치본 로그는 남아 있지 않아 확인 못 함).
- **`bot.needs_you` 의 `text`:** `question.text` 에 선택지가 이미 풀려 있어 두 번 나왔습니다. `ask.context` 를 씁니다.

시험 뒤 정리: 개발 플러그인 `local.grokbot-notify` 는 지우지 않고 비활성화만 했습니다(설정에 로컬 시험 라우트가 남아 있음). helm-probe 채팅에는 `실측 C: 어느 쪽?` 카드가 답을 기다리고 있습니다.

## 4. 남은 결정

- 답 메일의 `--type`: `handoff` 로 실측에서 봇이 답을 반영하고 item을 닫았습니다. 그대로 둘지 정합니다.
- 봇 채팅의 `done` 알림: 라우트에 봇 이름을 넣으면 봇 턴이 끝날 때마다 `done` 도 갑니다. 봇 채팅만 `states` 를 다르게 둘지 정해야 합니다.
- 봇 채팅의 `blocked` 알림에 대기 중인 질문 글을 실을지 정해야 합니다(`orca agent read` 로 읽힘, 선택지는 없음). 답은 어차피 Orca 화면에서 해야 합니다.
- 테스트 봇 helm-probe와 비활성화한 개발 플러그인을 남길지 정해야 합니다.
- 웹훅 진입점(클라우드 로그인)을 쓸지 정해야 합니다.
- Grok Bot 루틴이 `bot.needs_you` 를 카드로 보여 주도록 고쳐야 합니다(루틴은 이 저장소 밖).
- `bot item` 은 숨은 명령이라 Orca 업데이트로 바뀔 수 있습니다.

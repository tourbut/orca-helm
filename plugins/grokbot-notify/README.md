# grokbot-notify

한국어 · [English](#english)

orca-helm 세트의 알림 쪽 절반입니다. Orca 자체 알림 훅(플러그인 이벤트 `agent.status.changed`)을 받아, 에이전트가 `done` / `waiting` / `blocked` 가 되면 그 알림을 Grok Bot 루틴에 넘겨줍니다. GitHub 웹훅과는 관계없습니다. Grok Bot이 PC의 Orca를 조작하는 CLI와 함께 설치해야 합니다.

설치, Grok Bot 루틴 연결(`auth.set`), 보내는 JSON, 설정, 권한은 저장소 루트 [README.md](../../README.md#grokbot-notify-플러그인) 에 있습니다. 매니페스트는 루트의 `orca-plugin.json` 이고, 개발 폴더도 그 루트입니다.

## 파일

| 파일 | 내용 |
| --- | --- |
| `worker/main.mjs` | `activate(orca)`: 알림 훅 처리, 전송·재시도, `auth.set` / `auth.status` / `test.send` 핸들러 |
| `worker/core.mjs` | 순수 함수: `parseStates`, `createDebouncer`, `buildPayload` |
| `test/*.test.mjs` | 단위 테스트와 로컬 HTTP 스텁·모의 Orca로 워커를 돌리는 테스트 |

## 테스트

저장소 루트에서:

```sh
npm test
orca plugin dev emit . agent.status.changed --data '{"workspaceId":null,"paneKey":"p1","terminalId":"t1","title":"demo","state":"done","receivedAt":1730000000000,"mainAgent":{"state":"done","outcome":"success","stateStartedAt":1730000000000}}'
orca plugin logs local.grokbot-notify
```

Windows PowerShell 5.1에서는 `--data` 의 JSON 따옴표가 깨질 수 있으니 `\"` 로 이스케이프하거나 Git Bash에서 실행하세요.

## 공개 배포 방법

매니페스트가 저장소 루트에 있으므로 디렉터리는 이 저장소 자체를 봅니다.

1. `orca plugin validate .`
2. `orca-plugin.json` 과 `package.json` 의 `version` 을 올려 커밋·푸시하고, 그 커밋에 태그를 붙여 푸시합니다: `git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z`
3. `gh repo edit tourbut/orca-helm --add-topic orca-plugin`

## 상태

로컬 스텁과 모의 Orca로만 검증했습니다. 실제 Orca에 로드해 Grok Bot까지 보낸 확인은 아직 없습니다.

## English

The alert half of the orca-helm set. It receives Orca's own alert hook (the plugin event `agent.status.changed`) and, when an agent becomes `done`, `waiting` or `blocked`, hands the alert to the Grok Bot routine. It is unrelated to GitHub webhooks. Install it together with the CLI that Grok Bot uses to drive Orca on the PC.

Install, connecting the Grok Bot routine (`auth.set`), the JSON it sends, settings and capabilities are in the root [README.en.md](../../README.en.md#the-grokbot-notify-plugin). The manifest is the root `orca-plugin.json`, and the development folder is the repo root.

- `worker/main.mjs`: `activate(orca)`; handles the alert hook, delivery and retry, and the `auth.set` / `auth.status` / `test.send` handlers.
- `worker/core.mjs`: pure helpers `parseStates`, `createDebouncer`, `buildPayload`.
- Tests: `npm test` from the repo root; the worker test uses a local HTTP stub and a mock Orca.
- Release: `orca plugin validate .`, bump `version` in `orca-plugin.json` and `package.json`, tag that commit `vX.Y.Z`, and add the `orca-plugin` topic.

Status: checked against a local stub and a mock Orca only, not yet end to end in a real Orca.

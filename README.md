# Grok Bot Notify

Forwards Orca `agent.status.changed` events to a webhook. Built for Grok Bot webhook routines; works with any HTTP endpoint.

Orca 에이전트 상태 변경을 웹훅으로 전달하는 플러그인입니다. Grok Bot 웹훅 루틴용으로 만들었지만 아무 웹훅에나 쓸 수 있습니다.

## 무엇을 하나요

Orca 에이전트 상태(`working` / `blocked` / `waiting` / `done`)가 바뀔 때 설정한 HTTP(S) 웹훅으로 JSON을 POST합니다. 기본값은 `done,waiting,blocked`만 보내며 `working`은 보내지 않습니다. 같은 터미널·페인의 같은 상태는 `debounceSeconds`(기본 30초) 안에 다시 보내지 않습니다.

## 설치

로컬 개발 폴더로 로드합니다. 첫 실행이 fingerprint를 출력하면 그 값으로 다시 승인합니다.

```sh
orca plugin dev load <dir> --approve <fingerprint>
```

또는 폴더를 감시하면서 로드합니다.

```sh
orca plugin dev watch .
```

또는 **Settings → Plugins → Development folders**에서 이 폴더를 추가합니다. 로드되면 `local.grokbot-notify`로 보입니다.

## 설정

Orca **Settings**에서 이 플러그인 아래에 표시됩니다.

| 키 | 설명 |
| --- | --- |
| `webhookUrl` | POST할 HTTP(S) URL |
| `states` | 전달할 상태. 쉼표로 구분. 기본값 `done,waiting,blocked` |
| `debounceSeconds` | 같은 키·같은 상태를 다시 보내기 전 대기 초. 기본값 `30` |
| `authValue` | Authorization 헤더 값. 한 번 붙여 넣으면 워커가 암호화된 secrets로 옮기고 이 칸을 비웁니다 |

auth 값은 설정의 `authValue` 칸에 한 번 붙여 넣거나 다음으로 넣습니다.

```sh
orca plugin dev request . auth.set --data '{"value":"..."}'
```

값은 루틴의 헤더 값이며 `Authorization:` 접두어 없이 넣습니다. 워커가 암호화된 secrets로 옮기고 칸을 비웁니다. Linux `basic_text` 환경에서는 `secrets.set`이 실패할 수 있습니다.

현재 저장 여부는 다음으로 확인합니다.

```sh
orca plugin dev request . auth.status
```

## 테스트

```sh
orca plugin dev emit . agent.status.changed --data '{"workspaceId":null,"paneKey":"p1","terminalId":"t1","title":"demo","state":"done","receivedAt":1730000000000,"mainAgent":{"state":"done","outcome":"success","stateStartedAt":1730000000000}}'
```

```sh
orca plugin dev request . test.send
```

Windows PowerShell에서는 `--data`의 JSON 따옴표가 깨질 수 있으니, 필요하면 `'{\"value\":\"...\"}'`처럼 이스케이프하거나 Git Bash에서 실행하세요.

```sh
orca plugin logs local.grokbot-notify
```

```sh
node --test test/
```

## 보내는 JSON 예시

```json
{
  "event": "agent.status.changed",
  "state": "done",
  "outcome": "success",
  "title": "demo",
  "terminalId": "t1",
  "paneKey": "p1",
  "workspaceId": null,
  "worktree": "my-app",
  "repo": null,
  "receivedAt": "2024-10-27T00:53:20.000Z",
  "host": "hostname"
}
```

`outcome`은 `event.mainAgent.outcome`이고 없으면 `null`입니다. `worktree`는 이벤트의 `terminalId`가 현재 워크스페이스 터미널에 있을 때 `workspace.readContext`의 `displayName`이며, 아니면 `null`입니다. `repo`는 알 수 없으면 `null`입니다.

## 공개 배포 방법

나중에:

1. `orca plugin validate .`
2. `orca-plugin.json`의 `version`을 올려 커밋·푸시하고, 그 커밋에 태그를 붙여 푸시합니다: `git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z`
3. `gh repo edit tourbut/orca-grokbot --add-topic orca-plugin`

## 상태

실험 단계입니다. 실제 Orca에서 아직 검증하지 않았습니다. Grok Bot 웹훅 루틴용으로 만들었지만 아무 웹훅에나 쓸 수 있습니다.

# orca-helm

[English](README.en.md) · 한국어

**orca-helm은 Grok Bot이 사용자 PC(Windows/macOS)에서 돌아가는 Orca IDE를 원격으로 쉽게 다루기 위한 도구 세트입니다.** 두 부분이 한 세트이고, 둘 다 설치해야 합니다.

1. **orca-helm CLI** — Grok Bot이 PC의 셸에서 명령으로 호출합니다. Orca 상태 확인(`status`), 터미널 찾기·읽기(`find`, `read`), 작업 지시(`send`, `start`), 완료 대기(`wait`)를 명령 하나씩으로 처리합니다.
2. **grokbot-notify 플러그인** — Orca에 설치하는 플러그인입니다. Orca 자체 알림 훅(플러그인 이벤트 `agent.status.changed`)을 받아, 에이전트가 `done` / `waiting` / `blocked` 가 되면 그 알림을 Grok Bot에 넘겨줍니다. GitHub 이슈·푸시 웹훅과는 관계없습니다.

Grok Bot은 CLI로 일을 맡기고 결과를 읽으며, 플러그인 알림으로 언제 다시 볼지 압니다. 의존성 없는 Node.js(18 이상, ESM) 프로그램이고, 공식 `orca` CLI를 감쌉니다.

## 왜 있나

원격 셸은 명령마다 승인이 필요하고, 봇은 짧고 안정적인 출력을 원합니다.

- 진입점이 하나입니다. 출력은 UTF-8이고, PowerShell이 결과를 변수나 파이프로 받으면 `orca-helm.ps1`이 바깥 코드 페이지로 다시 씁니다.
- 긴 프롬프트는 명령줄 따옴표 대신 UTF-8 파일(`--file`)로 넘깁니다.
- `orca worktree ps --json` 은 수십 KB입니다. `status` 는 터미널당 한 줄로 줄입니다.
- handle 대신 repo, worktree, 브랜치, 제목으로 대상을 찾습니다.
- 에이전트가 끝났는지 기다리는 방법이 둘입니다. CLI의 `wait` 가 폴링하고, 플러그인이 알림을 보냅니다.

## 설치

필요한 것: Node.js 18 이상, Orca 1.4.246 이상(실행 중), 등록된 Orca CLI. 아래 1~3단계를 모두 해야 합니다.

### 1. CLI 받기

Windows (PowerShell):

```powershell
git clone https://github.com/tourbut/orca-helm C:\tools\orca-helm
cd C:\tools\orca-helm
.\orca-helm.ps1 status
```

macOS / Linux:

```sh
git clone https://github.com/tourbut/orca-helm ~/orca-helm
cd ~/orca-helm
chmod +x orca-helm
./orca-helm status
```

PATH에 넣으려면 Windows는 `C:\tools\orca-helm` 을 PATH에 추가하고, macOS/Linux는 `ln -s "$(pwd)/orca-helm" ~/.local/bin/orca-helm` 으로 링크합니다. `status` 가 터미널 목록을 출력하면 CLI 준비가 끝났습니다.

### 2. grokbot-notify 플러그인 설치

같은 clone 폴더를 Orca에 개발 폴더로 등록합니다. 플러그인 매니페스트는 저장소 루트의 `orca-plugin.json` 입니다.

- Orca **Settings → Plugins → Development folders** 에 clone 폴더를 추가합니다.
- 또는 clone 폴더에서 `orca plugin dev load .` 을 실행합니다. fingerprint가 출력되면 `orca plugin dev load . --approve <fingerprint>` 로 승인합니다.

로드되면 플러그인 키는 `local.grokbot-notify` 입니다. 요청 권한은 아래 [권한](#권한) 표의 네 가지뿐입니다.

### 3. Grok Bot 루틴 연결

Orca 오른쪽 사이드바의 **Grok Bot** 패널(로봇 아이콘)에서 봇을 추가합니다. 봇마다 그 봇의 루틴 화면에서 **URL**과 **Authorization 값** 두 개를 복사해 둡니다.

1. **봇 추가** 를 누릅니다.
2. **봇 이름**(예: 풀로), **Grok Bot routine URL**, **Authorization value** 칸을 채웁니다. Authorization 칸은 비밀번호 칸이라 글자가 가려지고, `Authorization:` 접두어가 있어도 됩니다.
3. **워크스페이스** 에서 이 봇이 받을 레포나 워크스페이스를 체크합니다. 목록은 지금 Orca에 열린 워크스페이스의 레포 이름(레포가 아니면 워크스페이스 이름)입니다. 아무것도 체크하지 않으면 모든 워크스페이스를 받습니다.
4. **저장** 을 누릅니다. 카드에 `Authorization 저장됨` 이 보이면 끝입니다. 값은 암호화된 플러그인 secrets에만 있고 패널에는 다시 나오지 않습니다.

카드의 **편집** 으로 바꾸거나 **삭제**(한 번 더 눌러 확인)합니다. 편집할 때 Authorization 칸을 비워 두면 저장된 값을 그대로 씁니다. 봇 이름을 바꿔도 저장된 값은 따라갑니다. 실제 URL과 Authorization 값은 문서나 저장소에 남기지 마세요.

패널은 Settings의 `Routes` 칸에 봇마다 한 줄을 써 넣습니다. 0.3.0에서 쓰던 줄은 그대로 패널에 카드로 나오고, 칸에 직접 한 줄씩 붙여 넣어도 됩니다.

```text
봇이름 | 워크스페이스1,워크스페이스2 | 루틴 URL | Authorization 값
```

예 (레포별로 다른 봇, 값은 자리표시자):

```text
# 봇이름 | 워크스페이스 | 루틴 URL | Authorization
풀로 | Fullops-Squad-plugin,orca-helm | <풀로 루틴 URL> | <풀로 Authorization 값>
노리 | jevpet | <노리 루틴 URL> | <노리 Authorization 값>
링크 | KnowsLink | <링크 루틴 URL> | <링크 Authorization 값>
```

- 저장하면 워커가 각 줄의 Authorization 값을 암호화된 플러그인 secrets로 옮기고 그 줄을 `풀로 | Fullops-Squad-plugin,orca-helm | <URL> | (saved)` 로 바꿉니다. 다시 붙여 넣을 필요가 없습니다.
- `Authorization:` 접두어가 붙어 있어도 됩니다. 같은 봇이름으로 새 줄을 붙이면 예전 줄을 대신합니다(값 교체).
- 빈 줄과 `#` 주석을 쓸 수 있습니다. 형식이 틀린 줄은 건너뛰고, 로그에 줄 번호와 이유만 남깁니다.
- 실제 URL과 Authorization 값은 문서나 저장소에 남기지 마세요.

명령줄로 한 줄씩 넣을 수도 있습니다(개발 폴더로 로드한 경우). `.` 은 clone 폴더이고, 다른 곳에서는 폴더 경로나 `local.grokbot-notify` 를 씁니다. Windows PowerShell 5.1은 JSON 안의 따옴표를 깨뜨리므로 `\"` 로 이스케이프하거나 PowerShell 7.3 이상 또는 Git Bash에서 실행하세요.

```sh
orca plugin dev request . auth.set --data '{"route":"풀로 | Fullops-Squad-plugin,orca-helm | <루틴 URL> | <Authorization 값>"}'
```

봇이 하나뿐이면 예전처럼 `Grok Bot routine URL` 과 `Authorization value` 칸(또는 `auth.set` 의 `{"url","value"}`)만 채워도 됩니다. `Routes` 에 올바른 줄이 하나라도 있으면 이 두 칸은 쓰지 않습니다.

확인:

```sh
orca plugin dev request . auth.status   # routes마다 hasAuth, 틀린 줄은 errors
orca plugin dev request . test.send     # 모든 봇 루틴에 테스트 알림(done) 한 번씩 전송
orca plugin logs local.grokbot-notify   # 전송 실패, 건너뛴 줄 등 워커 로그
```

## Grok Bot이 쓰는 흐름

Grok Bot은 PC 셸에서 orca-helm을 호출합니다. Windows는 `C:\tools\orca-helm\orca-helm.ps1 <명령>`, macOS는 `~/orca-helm/orca-helm <명령>` 입니다.

1. `status` 로 지금 무엇이 돌고 있는지 봅니다.
2. `send <대상> --file <프롬프트>` 로 기존 터미널에 일을 맡기거나, `start <repo> --name <이름> --file <프롬프트>` 로 새 worktree와 에이전트를 만듭니다.
3. 플러그인 알림(`done` / `waiting` / `blocked`)을 받거나 `wait <대상>` 으로 기다립니다.
4. `read <대상> --plain` 으로 결과를 읽습니다.

## 명령

```powershell
.\orca-helm.ps1 status
.\orca-helm.ps1 status fullops
.\orca-helm.ps1 status --all --json
.\orca-helm.ps1 find fullops
.\orca-helm.ps1 read jevpet --plain --lines 40
.\orca-helm.ps1 send jevpet --file C:\tmp\prompt.txt
.\orca-helm.ps1 start fullops --name fix-x --agent claude --file C:\tmp\p.txt
.\orca-helm.ps1 wait jevpet --timeout 600
.\orca-helm.ps1 raw worktree ps --json
```

기본 출력은 짧은 텍스트이고, `--json` 은 JSON 한 줄입니다.

| 명령 | 동작 |
| --- | --- |
| `status [query] [--all]` | 터미널마다 한 줄. waiting, working, done, shell, idle, unknown 순. 기본은 archived worktree 제외, `--all` 은 포함. `--json` 은 `{"rows":[...]}` |
| `find <query>` | archived 포함 상위 10개. `repo list` 의 repo 이름·경로도 봅니다. 줄 끝에 `worktreeId`, `repoId`, `handle`. `--json` 은 `{"matches":[...]}` (각 항목에 `score`) |
| `read <target> [--lines 40] [--screen] [--plain]` | 마지막 N줄. `--lines 0` 은 0줄. `--screen` 은 `orca terminal read --screen`. `--plain`(같은 뜻 `--strip-tui`)은 TUI 테두리·입력창·하단 상태·사이드패널·도구 줄을 뺀 뒤 N줄을 셉니다. 괄호만 있는 줄, 표, 코드, diff 같은 내용 줄은 남깁니다. `--json` 은 `{"handle","status","lines","truncated"}`, `--plain` 이면 `"plain":true` 추가 |
| `send <target> (--file \| --text) [--no-enter] [--interrupt]` | 기본은 Enter까지 보냅니다. `--file` 끝의 빈 줄은 뺍니다(Enter가 두 번 되지 않게). `--interrupt` 는 `orca terminal send --interrupt` 로 넘깁니다. 출력 `sent <repo>/<worktree> t:<handle>` |
| `start <repo> --name <name> [--agent claude\|codex] (--file \| --text)` | `repo list` 에서 repo 하나를 고르고 `orca worktree create --prompt` 를 실행합니다. 출력 `created <이름> id:<worktreeId> repo:<repoId>`, 다음 줄 `t:<handle>` |
| `wait <target> [--timeout 600] [--interval 5] [--for agent\|tui-idle\|exit] [--fresh 60]` | 아래 [wait](#wait) 참고. 초 단위 |
| `raw [--] <args>` | 같은 orca 바이너리에 그대로 전달하고 종료 코드도 그대로 돌려줍니다. `--` 는 없어도 됩니다 |
| `help`, `--help`, `--version` | 도움말, 버전 |

`--out <file>` 은 어떤 명령이든(`raw` 포함) stdout을 UTF-8(BOM 없음) 파일로 쓰고 stdout에는 아무것도 찍지 않습니다. stderr에 `wrote <file>` 한 줄이 나가며 종료 코드는 같습니다. `--json` 과 같이 쓸 수 있습니다.

값을 받는 플래그는 `--name value` 와 `--name=value` 둘 다 됩니다. `-` 로 시작하는 값(`--text "- 항목"`)도 받습니다. `--` 로 시작하는 토큰만 다음 플래그로 봅니다.

위치 인자는 `raw` 를 빼면 명령마다 하나(대상이나 질의)입니다. 공백이 있는 질의는 따옴표로 묶으세요. 남는 인자가 있으면 실행하지 않고 종료 코드 1과 그 명령의 사용법을 stderr에 출력합니다(`orca-helm: unexpected argument "main" ...`).

### 대상 찾기

`<target>` 은 handle(`t:<handle>` 또는 handle 그대로)이나 이름입니다.

- handle이 정확히 같으면 그 터미널입니다.
- 아니면 repo, worktree 라벨, 브랜치, 터미널 제목, handle, `repo/worktree` 를 비교합니다. 대소문자와 공백·`-`·`_`·`.`·`/` 는 무시하고, 완전 일치 > 앞부분 일치 > 포함 > 순서대로 포함 순입니다. 한글도 됩니다.
- 1등이 같은 worktree의 여러 터미널이면 에이전트가 붙은 터미널 하나를 고릅니다.
- 그래도 여럿이면 종료 코드 3과 함께 후보를 출력합니다(`--json` 은 `{"ambiguous":[...]}`).

`status` 한 줄 예: `fullops/main  t:<handle>  waiting  claude  "title"  12m`

상태 칸은 `working` / `waiting` / `done` / `shell` / `idle` / `unknown` 입니다. `permission` 과 `blocked` 는 `waiting`, worktree `active` 와 `inactive` 는 `idle` 입니다. 터미널만 있고 에이전트가 없으면 `shell` 입니다. 같은 `repo/worktree` 라벨이 여러 worktree면 `~` 와 짧은 경로 조각으로 구분합니다(`jevpet/jevpet~982c69f1`). `--json` 의 `state` 는 에이전트가 있으면 Orca가 준 원래 값입니다.

### wait

- 대상은 시작할 때 한 번 터미널 handle로 정하고, 그 뒤로는 그 handle만 봅니다. 기다리는 중 비슷한 이름의 worktree가 생겨도 대상이 바뀌지 않습니다. 터미널이 없는 대상은 바로 오류이고, 기다리는 중 그 터미널이 사라지면 `terminal t:<handle> (<repo>/<worktree>) is gone` 으로 종료 코드 1입니다.
- `--for agent`(기본): `--interval` 초마다 다시 조회합니다(0이면 0.25초). working을 본 뒤 waiting/done/idle/shell이 되면 끝납니다. 처음부터 waiting/done이어도 최근 `--fresh` 초 안에 바뀐 것이면 끝납니다. 오래된 done은 이전 턴의 것으로 보고 무시합니다. `shell` 과 `idle` 은 fresh만으로는 끝나지 않습니다. 출력은 `status` 한 줄, `--json` 은 `{"row":{...},"timedOut":false}` 입니다.
- `--for tui-idle` / `--for exit`: `orca terminal wait` 에 맡깁니다. 출력은 `satisfied|timeout <repo>/<worktree> t:<handle> <mode>`, `--json` 은 Orca의 wait 결과입니다.
- 시간 초과는 종료 코드 2입니다.

## 종료 코드

| 코드 | 의미 |
| --- | --- |
| 0 | 성공 |
| 1 | 오류. stderr는 `orca-helm: ...` |
| 2 | `wait` 시간 초과 |
| 3 | 대상(또는 `start` 의 repo)이 여러 개. 후보를 stdout에 출력 |

## 플랫폼 메모

**Windows.** `orca-helm.ps1` 이 기본 진입점입니다. node가 stdout을 임시 파일에 UTF-8로 쓰고, 스크립트가 그것을 읽어 줄마다 PowerShell 파이프라인으로 내보냅니다. 그래서 `$o = .\orca-helm.ps1 status --json` 이나 `.\orca-helm.ps1 status --json | ConvertFrom-Json` 이 원격 셸처럼 stdout이 리다이렉트된 PowerShell 안에서도 한글 그대로 동작하고, 바깥 PowerShell이 `$o = powershell -File .\orca-helm.ps1 status` 처럼 새 프로세스로 받으면 그 콘솔의 코드 페이지(한글 Windows는 CP949)로 나갑니다. UTF-8 바이트가 필요하면 `ORCA_HELM_ENCODING=utf8` 을 설정합니다(끝나면 콘솔 코드 페이지를 되돌립니다). stderr는 node 그대로 나가고, `wait` 출력은 끝날 때 한 번에 나옵니다. PowerShell은 `--` 를 삼키므로 `raw` 는 `--` 없이도 됩니다. `orca-helm.cmd` 는 `chcp 65001` 로 맞춘 뒤 이전 코드 페이지로 되돌리고 종료 코드를 유지합니다. `node bin\orca-helm.mjs` 를 직접 실행해도 됩니다.

Windows에서는 `orca.cmd`(cmd.exe 래퍼, 따옴표를 깨뜨림) 대신 같은 폴더의 `orca.exe` 를 실행합니다. `ORCA_HELM_BIN` 에도 `orca.exe` 경로를 쓰세요. 최신 Node는 셸 없이 `.cmd` 를 실행하지 않아 `cannot execute ...: EINVAL` 로 끝납니다.

**macOS / Linux.** `orca-helm` 은 POSIX `sh` 스크립트이고 심볼릭 링크를 따라가 자기 위치를 찾습니다. node는 UTF-8로 씁니다. macOS CLI는 Orca Settings → General → Orca CLI로 등록합니다(Intel은 `/usr/local/bin/orca`, Apple Silicon은 `~/.local/bin/orca`). Linux `.deb`/`.rpm` 은 `/usr/bin/orca-ide`, 그 외는 `~/.local/bin/orca-ide` 입니다.

**orca 바이너리 찾는 순서.** `ORCA_HELM_BIN` 이 있으면 그 경로입니다. 없으면:

- Windows: PATH의 `orca.exe` → PATH의 `orca.cmd` 옆 `orca.exe` → `%LOCALAPPDATA%\Programs\Orca\bin\orca.exe`
- macOS: PATH의 `orca` → `~/.local/bin/orca` → `/usr/local/bin/orca` → `/opt/homebrew/bin/orca`
- Linux: PATH의 `orca-ide` → PATH의 `orca` → `~/.local/bin/orca-ide` → `/usr/bin/orca-ide`

못 찾으면 시도한 위치를 나열하고 종료 코드 1로 끝납니다.

**기타.** 터미널 handle은 그 Orca 프로세스가 살아 있는 동안만 유효하고, 명령마다 다시 조회합니다. 프롬프트 파일은 UTF-8이며 BOM은 빼고 CRLF는 LF로 바꿉니다.

## grokbot-notify 플러그인

Orca가 플러그인에 주는 알림 훅 `agent.status.changed` 를 받아 Grok Bot 루틴 URL로 JSON을 POST합니다. orca-helm CLI와 한 세트이며, Grok Bot은 이 알림으로 언제 `read` 할지 압니다. 설치와 연결은 위 [설치](#설치) 2~3단계입니다.

### 동작

- **봇별 라우팅:** 알림은 `Routes` 의 줄 가운데 워크스페이스가 맞는 봇마다 한 번씩 보냅니다. 워크스페이스 항목이 repo 이름이나 Orca 워크스페이스 이름과 같거나(대소문자 무시) worktree 경로에 들어 있으면 맞습니다. 워크스페이스 칸이 비어 있는 줄은 모든 워크스페이스에 맞습니다. 어느 줄에도 맞지 않으면 아무것도 보내지 않습니다(네트워크 호출 없음, 중복 억제 기록도 없음).
- `Routes` 에 올바른 줄이 없으면 예전처럼 `webhookUrl` 하나로 모든 워크스페이스를 보냅니다.
- 기본으로 `done`, `waiting`, `blocked` 만 넘깁니다. `working` 은 넘기지 않습니다(`states` 설정으로 바꿀 수 있음).
- 같은 터미널의 같은 상태는 봇마다 `debounceSeconds`(기본 30초) 안에 다시 보내지 않습니다. 그 사이 다른 상태(예: `working`)가 있었으면 새 턴으로 보고 다시 보냅니다.
- 연결 실패, 429, 5xx는 봇마다 2초 뒤 한 번 더 보냅니다. 10초 타임아웃은 Grok Bot이 이미 받았을 수 있어 다시 보내지 않습니다. 실패는 봇 이름과 함께 `orca plugin logs local.grokbot-notify` 에 남습니다.
- worktree 이름과 브랜치는 `workspace.list` 로, repo 이름은 worktree의 `.git` 으로 찾습니다(본 worktree는 그 폴더 이름, 연결된 worktree는 `gitdir:` 가 가리키는 본 저장소 폴더 이름). 못 찾으면 `null` 입니다.
- 마지막 응답 내용은 담기지 않습니다. Orca 알림 훅이 주지 않습니다. 내용은 `orca-helm read <repo>/<worktree> --plain` 으로 읽습니다.

### 보내는 JSON

```json
{
  "event": "agent.status.changed",
  "text": "orca-helm/fix-login: done (success) - Fix login redirect",
  "state": "done",
  "outcome": "success",
  "title": "Fix login redirect",
  "terminalId": "term_…",
  "paneKey": "tab…:leaf…",
  "workspaceId": "<repoId>::<worktree path>",
  "worktree": "fix-login",
  "branch": "fix-login",
  "repo": "orca-helm",
  "route": "풀로",
  "receivedAt": "2026-11-03T12:00:00.000Z",
  "host": "my-pc"
}
```

- `text`: 루틴이 그대로 전달할 수 있는 한 줄. `<repo>/<worktree>: <state> (<outcome>) - <title>`. `<repo>/<worktree>` 는 `orca-helm status` 의 라벨과 같아 그대로 대상으로 쓸 수 있습니다. 둘 다 모르면 `Orca`.
- `state`: Orca가 준 상태(`done` / `waiting` / `blocked` / `working`). `outcome`: `success` / `failure` 또는 `null`.
- `title`: 터미널 제목. `terminalId` 는 orca-helm의 handle과 같아서 `orca-helm read t:<terminalId>` 로 바로 읽을 수 있습니다.
- `worktree`, `branch`, `repo`: worktree 이름, 브랜치, repo 폴더 이름. 모르면 `null`.
- `route`: 이 알림을 받은 봇 이름(`Routes` 줄의 첫 칸). `webhookUrl` 하나로 보낼 때는 `null`.
- `receivedAt`: Orca가 상태를 받은 시각(ISO 8601). `host`: PC 호스트 이름.

### 설정

Orca **Settings** 에서 이 플러그인 아래에 보입니다.

| 키 | 화면 이름 | 설명 |
| --- | --- | --- |
| `routes` | Routes (one Grok Bot per line) | 보통은 **Grok Bot** 패널이 씁니다. 여러 줄, 한 줄에 봇 하나: `봇이름 \| 워크스페이스1,워크스페이스2 \| 루틴 URL \| Authorization 값`. 저장하면 끝 칸이 `(saved)` 로 바뀝니다. [설치 3단계](#3-grok-bot-루틴-연결) 참고 |
| `webhookUrl` | Grok Bot routine URL | `routes` 가 비어 있을 때만: 모든 워크스페이스를 받을 루틴 URL 하나. `auth.set` 의 `url` 로도 넣습니다 |
| `authValue` | Authorization value | `routes` 가 비어 있을 때만: 위 URL의 Authorization 값. 붙여 넣으면 워커가 바로 secrets로 옮기고 칸을 비웁니다 |
| `states` | States | 넘길 상태, 쉼표로 구분. 기본 `done,waiting,blocked` |
| `debounceSeconds` | Debounce seconds | 같은 상태를 다시 보내기 전 대기 초. 기본 `30` |

### 핸들러

Grok Bot 패널은 `plugin.request` 로 `routes.*` 를 부릅니다. 명령줄에서는 `orca plugin dev request <폴더|local.grokbot-notify> <이름>` 으로 부르며, 개발 폴더로 로드한 플러그인에서만 됩니다.

| 이름 | 입력 | 결과 |
| --- | --- | --- |
| `routes.list` | 없음 | `{"routes":[{"name","url","workspaces","hasAuth"}],"workspaces":[체크박스 후보],"errors":[{"line","reason"}]}`. Authorization 값은 돌려주지 않습니다 |
| `routes.save` | `{"previousName"?, "name", "url", "workspaces": [...], "auth"?}` | 새 `routes.list` 결과. `auth` 가 비면 저장된 값을 그대로 두고, 이름이 바뀌면 값도 옮깁니다. 틀린 값은 이유만 담은 오류 |
| `routes.delete` | `{"name"}` | 새 `routes.list` 결과. 그 봇의 줄과 저장된 Authorization을 지웁니다 |
| `auth.set` | `{"route": "<routes 한 줄>"}` 또는 `{"url"?: string, "value"?: string}` | `{"ok":true}`. `route` 는 `routes` 끝에 붙어 같은 이름의 예전 줄을 대신합니다. 틀린 줄이면 이유만 담은 오류 |
| `auth.status` | 없음 | `{"hasAuth","hasUrl","protection","routes":[{"name","workspaces","hasAuth"}],"errors":[{"line","reason"}]}`. 값 자체는 돌려주지 않습니다 |
| `test.send` | 없음 | 모든 봇에 테스트 `done` 알림 한 번씩(워크스페이스·중복 억제 무시). `{"status","routes":[{"route","status"}]}` |

### 비밀값

- Authorization 값은 Orca의 암호화된 플러그인 secrets에만 저장합니다(봇마다 따로, 봇 이름으로 구분). `protection` 이 `unavailable` 이면(OS 키 저장소 없음, Linux `basic_text`) 저장이 실패하고, 그 줄은 값이 든 채로 남아 그 값으로 보냅니다.
- 워커 로그와 오류 메시지에는 Authorization 값과 루틴 URL을 쓰지 않습니다. URL에 토큰이 들어 있을 수 있기 때문입니다. 틀린 `routes` 줄도 줄 번호와 이유만 남깁니다.

### 권한

| capability | 쓰는 곳 |
| --- | --- |
| `agent:read` | `agent.status.changed` 알림 훅 받기 |
| `workspace:read` | `workspace.list` 로 worktree 이름·브랜치·경로 찾기, 패널의 워크스페이스 체크박스 목록 |
| `settings:own` | 자기 설정 읽기, `auth.set` 저장, Authorization 값을 `(saved)` 로 바꾸거나 칸 비우기 |
| `secrets:own` | Authorization 값 저장·읽기 |

터미널 읽기·입력, 에이전트 실행 권한은 요청하지 않습니다. 플러그인은 Grok Bot에 알림만 보내고, Orca를 조작하는 일은 CLI가 합니다. Grok Bot 패널(`plugins/grokbot-notify/panel/routes.tsx`, components 패널)은 따로 권한을 쓰지 않고 워커에만 요청합니다.

### 개발과 배포

```sh
orca plugin validate .
orca plugin dev emit . agent.status.changed --data '{"workspaceId":null,"paneKey":"p1","terminalId":"t1","title":"demo","state":"done","receivedAt":1730000000000,"mainAgent":{"state":"done","outcome":"success","stateStartedAt":1730000000000}}'
npm test
orca plugin test .
orca plugin check .
```

`npm test` 는 CLI와 플러그인 워커 테스트를 돌립니다(로컬 HTTP 스텁만 씀). `orca plugin test .` 는 Orca 런타임으로 패널과 실제 워커를 함께 돌리는 `panel/routes.test.tsx` 까지 돌리고, `orca plugin check .` 는 `panel/routes.check.ts` 의 시나리오대로 패널을 그려 봅니다. Orca 1.4.247(Windows)은 저장소가 Orca 설치 드라이브(C:)와 다른 드라이브에 있으면 이 두 명령이 `cannot import "./orca-runtime.mjs"` 로 실패합니다. 공식 템플릿도 같으므로, C: 드라이브에 복사해서 돌리세요.

태그가 있으면 Settings → Plugins → Install plugin에 `https://github.com/tourbut/orca-helm.git#v0.4.0` 같은 Git URL로도 설치할 수 있습니다. 이렇게 설치해도 Grok Bot 패널로 봇을 관리할 수 있습니다(`orca plugin dev request` 만 닿지 않습니다). 디렉터리(onorca.dev/plugins)는 공개 저장소 루트의 `orca-plugin.json`, 토픽 `orca-plugin`, 최신 `vX.Y.Z` 태그를 봅니다. 배포 절차는 [plugins/grokbot-notify/README.md](plugins/grokbot-notify/README.md) 에 있습니다.

상태: 워커는 로컬 HTTP 스텁과 모의 Orca로, Grok Bot 패널은 Orca 테스트 키트(대체 호스트)로 검증했습니다. 실제 Orca에 로드해 패널을 띄우고 Grok Bot까지 보낸 확인은 아직 없습니다.

# orca-helm

Grok Bot 같은 봇이 원격 셸로 **로컬 Orca IDE (v1.4.246)** 를 다루기 위한 작은 CLI입니다. 의존성 없는 Node.js(>=18, ESM) 프로그램이고, 공식 `orca` CLI를 하나의 진입점으로 감쌉니다.

## 왜 있나

원격 PowerShell은 명령마다 승인이 필요합니다. 봇은 안정적인 진입점 하나면 됩니다.

- 출력은 UTF-8이라 한글이 유지됩니다.
- 긴 프롬프트는 명령줄 따옴표 대신 UTF-8 파일(`--file`)로 넘깁니다.
- `orca worktree ps --json` 은 수십 KB(~68KB)입니다. `status` 가 터미널당 한 줄로 줄입니다.
- 에이전트가 `done` / `waiting` 인지 알 신호가 없습니다. `wait` 가 폴링합니다.
- handle 대신 repo, worktree, 브랜치, 제목으로 찾습니다.

## Windows 설치

Node.js 18 이상, 등록된 Orca CLI, 실행 중인 Orca가 필요합니다.

```powershell
git clone https://github.com/tourbut/orca-helm C:\tools\orca-helm
cd C:\tools\orca-helm
.\orca-helm.ps1 status
```

선택: `C:\tools\orca-helm` 을 PATH에 넣습니다. Orca 실행 파일 위치가 다르면 `orca.exe` 전체 경로를 지정합니다.

```powershell
$env:ORCA_HELM_BIN = 'C:\path\to\orca.exe'
```

Windows에서는 `orca.cmd`(cmd.exe 래퍼) 대신 같은 폴더의 `orca.exe` 를 직접 실행합니다. 진입점은 `orca-helm.ps1` 또는 `node bin\orca-helm.mjs` 를 쓰세요. `orca-helm.cmd` 는 `chcp 65001` 만 맞춥니다. 긴 텍스트는 `--file` 로 넘깁니다.

## 명령

```powershell
.\orca-helm.ps1 status
.\orca-helm.ps1 status fullops
.\orca-helm.ps1 status --all --json
.\orca-helm.ps1 find fullops
.\orca-helm.ps1 send jevpet --file C:\tmp\prompt.txt
.\orca-helm.ps1 start fullops --name fix-x --agent claude --file C:\tmp\p.txt
.\orca-helm.ps1 read jevpet --lines 40
.\orca-helm.ps1 wait jevpet --timeout 600
.\orca-helm.ps1 raw -- terminal list --json
```

기본 출력은 짧은 텍스트입니다. `--json` 은 JSON 한 줄입니다.

| 명령 | 동작 |
| --- | --- |
| `status [query] [--all]` | 터미널 한 줄 요약. waiting, working, 그 다음 순. `--all` 은 archived 포함 |
| `find <query>` | 상위 10개. `worktreeId`, `repoId`, handle 포함 |
| `read <target> [--lines 40] [--screen]` | handle 또는 이름. 마지막 N줄 |
| `send <target> (--file \| --text) [--no-enter] [--interrupt]` | 기본은 Enter까지 전송. handle이 정확히 같으면 그 터미널. 아니면 이름 검색. worktree에 터미널이 여러 개면 에이전트가 있는 쪽 |
| `start <repo> --name <name> [--agent claude\|codex] (--file \| --text)` | `repo list` 로 repo를 고르고 `worktree create` |
| `wait <target> [--timeout 600] [--interval 5] [--for agent\|tui-idle\|exit] [--fresh 60]` | 기본 `agent`: working을 본 뒤 waiting/done/idle이 되거나, 최근 `--fresh` 초 안에 바뀐 waiting/done이면 끝. 이전 턴의 오래된 done은 무시합니다. `tui-idle` / `exit` 는 `orca terminal wait`. 초 단위 |
| `raw -- <args>` | 같은 바이너리로 `orca` 에 그대로 전달 |

`status` 한 줄 예: `fullops/main  t:<handle>  waiting  claude  "title"  12m`

텍스트의 상태 칸은 `working` / `waiting` / `done` / `idle` / `unknown` 입니다. `permission` 과 `blocked` 는 `waiting` 으로 모읍니다. `--json` 의 `state` 는 Orca가 준 원래 값입니다.

## 종료 코드

| 코드 | 의미 |
| --- | --- |
| 0 | 성공 |
| 1 | 오류. stderr 는 `orca-helm: ...` |
| 2 | `wait` 시간 초과 |
| 3 | 대상이 여러 개. 후보를 출력하고 끝남 |

## 참고

- 터미널 handle은 그 Orca 프로세스가 살아있는 동안만 유효합니다. 명령마다 다시 조회합니다.
- 프롬프트 파일은 UTF-8입니다. BOM은 빼고, CRLF는 LF로 바꿉니다.
- Linux는 `orca-ide` 를 먼저 찾고, 없을 때 `orca` 를 찾습니다. macOS는 `orca`, Windows는 `orca.exe` 입니다. `ORCA_HELM_BIN` 이 있으면 그 경로를 씁니다.

## plugins/grokbot-notify

`plugins/grokbot-notify/` 는 에이전트 상태 변경을 웹훅으로 보내던 선택 플러그인입니다. 설치와 설정은 [plugins/grokbot-notify/README.md](plugins/grokbot-notify/README.md) 에 있습니다.

## English

orca-helm is a dependency-free Node.js CLI so a bot such as Grok Bot can drive a local Orca IDE v1.4.246 from a remote shell. One entry point fits a shell that approves each command. It writes UTF-8, reads long prompts from a file, compresses `worktree ps` to one line per terminal, waits until an agent is waiting or done, and resolves a worktree by name.

On Windows, clone to `C:\tools\orca-helm`, install Node.js 18+, and run `.\orca-helm.ps1 status`. Add that folder to `PATH` if you want. Set `ORCA_HELM_BIN` to the full path of `orca.exe` when it is not on `PATH`. Prefer `orca-helm.ps1` or `node bin/orca-helm.mjs`, and pass prompts with `--file`. Linux looks up `orca-ide` first.

`plugins/grokbot-notify/` is the older optional webhook notify plugin. See its README.

Exit codes: `0` ok, `1` error, `2` wait timeout, `3` ambiguous match.

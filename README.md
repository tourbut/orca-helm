# orca-helm

Grok Bot 같은 봇이 원격 셸로 **로컬 Orca IDE (v1.4.246)** 를 다루기 위한 작은 CLI입니다. 의존성 없는 Node.js(>=18, ESM) 프로그램이고, 공식 `orca` CLI를 하나의 진입점으로 감쌉니다.

## 왜 있나

원격 PowerShell은 명령마다 승인이 필요합니다. 봇은 안정적인 진입점 하나면 됩니다.

- 출력은 UTF-8입니다. PowerShell이 결과를 변수나 파이프로 받으면 `orca-helm.ps1`이 바깥 코드 페이지로 다시 씁니다.
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

Windows에서는 `orca.cmd`(cmd.exe 래퍼) 대신 같은 폴더의 `orca.exe` 를 직접 실행합니다. PATH에 없으면 `%LOCALAPPDATA%\Programs\Orca\bin\orca.exe` 를 찾습니다. 진입점은 `orca-helm.ps1` 또는 `node bin\orca-helm.mjs` 를 쓰세요. 긴 텍스트는 `--file` 로 넘깁니다.

`orca-helm.ps1`은 node stdout을 UTF-8 문자열로 받은 뒤, 출력이 리다이렉트돼 있으면 원래 `[Console]::OutputEncoding`(한글 Windows는 CP949)으로 다시 씁니다. 바깥 PowerShell 5.1이 `$o = powershell -File .\orca-helm.ps1 status` 처럼 받거나 파이프로 넘겨도 한글이 유지됩니다. 콘솔에 직접 찍을 때는 UTF-8입니다. UTF-8 바이트가 필요하면 `ORCA_HELM_ENCODING=utf8` 입니다. stderr는 node 그대로 나갑니다. `wait` 출력은 끝날 때 한 번에 나옵니다.

`orca-helm.cmd`는 `chcp 65001`로 맞춘 뒤 이전 코드 페이지로 되돌리고 종료 코드를 유지합니다.

`--out <file>` 은 어떤 명령이든 stdout을 UTF-8(BOM 없음) 파일로 쓰고, stdout에는 아무것도 찍지 않습니다. stderr에 `wrote <file>` 한 줄이 나가며 종료 코드는 같습니다. `--json`과 같이 쓸 수 있습니다.

```powershell
.\orca-helm.ps1 status --out C:\tmp\status.txt
.\orca-helm.ps1 read jevpet --plain --lines 40
```

## macOS / Linux

Node.js 18 이상, 등록된 Orca CLI, 실행 중인 Orca가 필요합니다. macOS CLI는 Settings → General → Orca CLI로 등록합니다. Intel은 `/usr/local/bin/orca`(그 디렉터리가 있을 때), Apple Silicon은 `~/.local/bin/orca` 입니다. Linux `.deb`/`.rpm`은 `/usr/bin/orca-ide`, 그 외는 `~/.local/bin/orca-ide` 입니다.

```sh
git clone https://github.com/tourbut/orca-helm
cd orca-helm
chmod +x orca-helm
./orca-helm status
```

PATH에 넣으려면 `~/.local/bin` 에 링크합니다.

```sh
ln -s "$(pwd)/orca-helm" ~/.local/bin/orca-helm
```

Orca 실행 파일이 PATH에 없으면 `ORCA_HELM_BIN`에 전체 경로를 넣습니다. macOS와 Linux에서 node는 UTF-8로 씁니다.

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
.\orca-helm.ps1 raw worktree ps --json
```

기본 출력은 짧은 텍스트입니다. `--json` 은 JSON 한 줄입니다.

| 명령 | 동작 |
| --- | --- |
| `status [query] [--all]` | 터미널 한 줄 요약. waiting, working, done, shell, idle 순. `--all` 은 archived 포함 |
| `find <query>` | 상위 10개. `worktreeId`, `repoId`, handle 포함 |
| `read <target> [--lines 40] [--screen] [--plain]` | handle 또는 이름. 마지막 N줄. `--plain`(같은 뜻 `--strip-tui`)은 TUI 상자·입력창·하단 상태·도구 줄을 뺀 뒤 N줄을 셉니다. `--json`이면 `plain: true` |
| `send <target> (--file \| --text) [--no-enter] [--interrupt]` | 기본은 Enter까지 전송. handle이 정확히 같으면 그 터미널. 아니면 이름 검색. worktree에 터미널이 여러 개면 에이전트가 있는 쪽 |
| `start <repo> --name <name> [--agent claude\|codex] (--file \| --text)` | `repo list` 로 repo를 고르고 `worktree create` |
| `wait <target> [--timeout 600] [--interval 5] [--for agent\|tui-idle\|exit] [--fresh 60]` | 기본 `agent`: working을 본 뒤 waiting/done/idle/shell이 되거나, 최근 `--fresh` 초 안에 바뀐 waiting/done이면 끝. `shell` 은 `idle` 과 같이 fresh만으로는 끝나지 않습니다. 이전 턴의 오래된 done은 무시합니다. `tui-idle` / `exit` 는 `orca terminal wait`. 초 단위 |
| `raw [--] <args>` | 같은 바이너리로 `orca` 에 그대로 전달. `--` 는 없어도 됩니다 |

`status` 한 줄 예: `fullops/main  t:<handle>  waiting  claude  "title"  12m`

텍스트의 상태 칸은 `working` / `waiting` / `done` / `shell` / `idle` / `unknown` 입니다. `permission` 과 `blocked` 는 `waiting`, worktree `active` 와 `inactive` 는 `idle` 입니다. 터미널만 있고 에이전트가 없으면 `shell` 입니다. 같은 `repo/worktree` 가 여러 worktree면 `~` 와 짧은 경로 조각으로 구분합니다 (`jevpet/jevpet~982c69f1`). `--json` 의 `state` 는 에이전트가 있으면 Orca가 준 원래 값이고, 없는 터미널은 `shell` 입니다.

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
- Linux는 PATH의 `orca-ide`, `orca`, 그다음 `~/.local/bin/orca-ide`, `/usr/bin/orca-ide` 순입니다. macOS는 PATH의 `orca`, `~/.local/bin/orca`, `/usr/local/bin/orca`, `/opt/homebrew/bin/orca` 순입니다. Windows는 PATH의 `orca.exe`, 그다음 `%LOCALAPPDATA%\Programs\Orca\bin\orca.exe` 입니다. `ORCA_HELM_BIN` 이 있으면 그 경로를 씁니다.
- `status jevpet/main` 처럼 `/` 가 있는 질의는 `repo/worktree` 라벨 전체와 맞습니다.

## Orca 플러그인

루트의 `orca-plugin.json` 은 에이전트 상태(`working` / `blocked` / `waiting` / `done`)를 웹훅으로 보내는 플러그인입니다. Grok Bot 웹훅 루틴용입니다. CLI 자체는 플러그인이 아닙니다. 바깥 호출자는 플러그인 명령을 실행할 수 없습니다. 워커와 설정은 [plugins/grokbot-notify/README.md](plugins/grokbot-notify/README.md) 에 있습니다.

태그가 있으면 Settings → Plugins → Install plugin에 Git URL을 넣습니다.

```text
https://github.com/tourbut/orca-helm.git#v0.2.0
```

개발 중에는 이 저장소 루트를 로컬 폴더로 설치합니다. Settings → Plugins → Development folders, 또는 `orca plugin dev load .`. 검사:

```sh
orca plugin validate .
```

디렉터리(onorca.dev/plugins)는 공개 GitHub 저장소 루트의 `orca-plugin.json`, 토픽 `orca-plugin`, 가장 최신 `vX.Y.Z` 태그를 봅니다. 토픽과 태그는 여기서 붙이지 않습니다.

## English

orca-helm is a dependency-free Node.js CLI so a bot such as Grok Bot can drive a local Orca IDE v1.4.246 from a remote shell. One entry point fits a shell that approves each command. It writes UTF-8, reads long prompts from a file, compresses `worktree ps` to one line per terminal, waits until an agent is waiting or done, and resolves a worktree by name. `status repo/worktree` matches that full label. `read --plain` strips TUI chrome before `--lines`. `--out <file>` writes stdout as UTF-8 with no BOM.

On Windows, clone to `C:\tools\orca-helm`, install Node.js 18+, and run `.\orca-helm.ps1 status`. `orca-helm.ps1` re-encodes captured stdout to the parent console code page; set `ORCA_HELM_ENCODING=utf8` to keep UTF-8 bytes. On macOS or Linux, `chmod +x orca-helm` and run `./orca-helm status`. Set `ORCA_HELM_BIN` when the Orca CLI is not on `PATH`.

The repo-root `orca-plugin.json` forwards agent status to a webhook. The CLI is not a plugin. Install from `https://github.com/tourbut/orca-helm.git#v0.2.0` after the tag exists. Listing needs the `orca-plugin` topic and a `vX.Y.Z` tag.

Exit codes: `0` ok, `1` error, `2` wait timeout, `3` ambiguous match.

# orca-helm

English · [한국어](README.md)

**orca-helm lets Grok Bot drive the Orca IDE running on a user's PC (Windows or macOS) remotely, without fuss.** It is one set of two parts, and you need both.

1. **The orca-helm CLI.** Grok Bot calls it as a shell command on the PC. One command each for checking Orca's state (`status`), finding and reading terminals (`find`, `read`), handing out work (`send`, `start`), and waiting for it to finish (`wait`).
2. **The grokbot-notify plugin.** You install it in Orca. It receives Orca's own alert hook (the plugin event `agent.status.changed`) and, when an agent becomes `done`, `waiting` or `blocked`, hands that alert to Grok Bot. It has nothing to do with GitHub issue or push webhooks.

Grok Bot hands out work and reads results through the CLI, and learns when to look again from the plugin's alerts. orca-helm is a dependency-free Node.js (18+, ESM) program that wraps the official `orca` CLI.

## Why

A remote shell asks for approval on every command, and a bot wants short, stable output.

- One entry point. Output is UTF-8; when PowerShell captures it into a variable or a pipe, `orca-helm.ps1` re-encodes it to the outer code page.
- Long prompts go through a UTF-8 file (`--file`), not command-line quoting.
- `orca worktree ps --json` runs to tens of KB. `status` prints one line per terminal.
- Targets are found by repo, worktree, branch or title, not only by handle.
- There are two ways to learn that an agent finished: the CLI's `wait` polls, and the plugin sends an alert.

## Install

You need Node.js 18+, Orca 1.4.246+ running, and the Orca CLI registered. Do all three steps.

### 1. Get the CLI

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

To put it on PATH, add `C:\tools\orca-helm` to PATH on Windows, or run `ln -s "$(pwd)/orca-helm" ~/.local/bin/orca-helm` on macOS/Linux. When `status` lists your terminals, the CLI is ready.

### 2. Install the grokbot-notify plugin

Register the same clone with Orca as a development folder. The plugin manifest is `orca-plugin.json` at the repo root.

- Add the clone under Orca **Settings → Plugins → Development folders**.
- Or run `orca plugin dev load .` in the clone. If it prints a fingerprint, approve it with `orca plugin dev load . --approve <fingerprint>`.

Once loaded, the plugin key is `local.grokbot-notify`. It asks only for the four capabilities in [Capabilities](#capabilities).

### 3. Connect the Grok Bot routine

Copy the **routine URL** and the **Authorization value** from the Grok Bot routine screen and set them with `auth.set`. Never write the real values into docs or the repo.

```sh
orca plugin dev request . auth.set --data '{"url":"<routine URL>","value":"<Authorization value>"}'
```

- `.` is the clone. Elsewhere, pass the folder path or `local.grokbot-notify`.
- `value` may keep its `Authorization:` prefix. The worker strips it and stores the value in Orca's encrypted plugin secrets.
- Windows PowerShell 5.1 breaks the quotes inside the JSON. Escape them as `'{\"url\":\"...\",\"value\":\"...\"}'`, or run the command from PowerShell 7.3+ or Git Bash.
- Instead of the command line, you can paste both into the plugin's `Grok Bot routine URL` and `Authorization value` fields in Orca **Settings**. The worker moves the Authorization value into secrets right away and clears the field.

Check:

```sh
orca plugin dev request . auth.status   # {"hasAuth":true,"hasUrl":true,...} means ready
orca plugin dev request . test.send     # sends one test alert (done) to the Grok Bot routine
orca plugin logs local.grokbot-notify   # worker log, including failed deliveries
```

## How Grok Bot uses it

Grok Bot calls orca-helm from the PC's shell: `C:\tools\orca-helm\orca-helm.ps1 <command>` on Windows, `~/orca-helm/orca-helm <command>` on macOS.

1. `status` shows what is running.
2. `send <target> --file <prompt>` gives work to an existing terminal, or `start <repo> --name <name> --file <prompt>` creates a worktree with a new agent.
3. It gets a plugin alert (`done` / `waiting` / `blocked`), or waits with `wait <target>`.
4. `read <target> --plain` reads the result.

## Commands

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

Output is short text by default; `--json` prints one line of JSON.

| Command | What it does |
| --- | --- |
| `status [query] [--all]` | One line per terminal, ordered waiting, working, done, shell, idle, unknown. Archived worktrees are left out unless `--all`. `--json` prints `{"rows":[...]}` |
| `find <query>` | Top 10, archived included. Also matches repo names and paths from `repo list`. Each line ends with `worktreeId`, `repoId`, `handle`. `--json` prints `{"matches":[...]}`, each with a `score` |
| `read <target> [--lines 40] [--screen] [--plain]` | The last N lines. `--lines 0` prints none. `--screen` passes `orca terminal read --screen`. `--plain` (alias `--strip-tui`) drops TUI boxes, the input box, footers and tool lines before counting N. `--json` prints `{"handle","status","lines","truncated"}`, plus `"plain":true` with `--plain` |
| `send <target> (--file \| --text) [--no-enter] [--interrupt]` | Sends the text and presses Enter unless `--no-enter`. Trailing blank lines of `--file` are dropped so Enter is not pressed twice. `--interrupt` is passed as `orca terminal send --interrupt`. Prints `sent <repo>/<worktree> t:<handle>` |
| `start <repo> --name <name> [--agent claude\|codex] (--file \| --text)` | Picks one repo from `repo list` and runs `orca worktree create --prompt`. Prints `created <name> id:<worktreeId> repo:<repoId>`, then `t:<handle>` |
| `wait <target> [--timeout 600] [--interval 5] [--for agent\|tui-idle\|exit] [--fresh 60]` | See [wait](#wait). Seconds |
| `raw [--] <args>` | Passes the args to the same orca binary and returns its exit code. The `--` is optional |
| `help`, `--help`, `--version` | Help and version |

`--out <file>` works with every command, `raw` included. It writes stdout to the file as UTF-8 without a BOM and prints nothing on stdout. stderr gets one `wrote <file>` line, and the exit code is unchanged. It combines with `--json`.

Flags that take a value accept both `--name value` and `--name=value`. A value may start with `-` (`--text "- item"`). Only a token that starts with `--` begins the next flag.

### Finding a target

`<target>` is a handle (`t:<handle>` or the bare handle) or a name.

- An exact handle match picks that terminal.
- Otherwise it compares the repo, worktree label, branch, terminal title, handle, and `repo/worktree`. Case, spaces, `-`, `_`, `.` and `/` are ignored. Exact beats prefix, prefix beats substring, substring beats in-order letters. Hangul works.
- When the best matches are several terminals of one worktree, it picks the one with an agent.
- If more than one is still left, it prints the candidates and exits 3 (`--json` prints `{"ambiguous":[...]}`).

A `status` line looks like `fullops/main  t:<handle>  waiting  claude  "title"  12m`.

The state column is `working` / `waiting` / `done` / `shell` / `idle` / `unknown`. `permission` and `blocked` show as `waiting`; worktree `active` and `inactive` show as `idle`. A terminal with no agent is `shell`. When one `repo/worktree` label covers several worktrees, a `~` and a short path piece tell them apart (`jevpet/jevpet~982c69f1`). In `--json`, `state` is Orca's raw value when an agent is attached.

### wait

- `--for agent` (default): re-reads every `--interval` seconds (0 means 0.25 s). It ends once the agent turns waiting/done/idle/shell after being seen working. It also ends at once on a waiting/done that changed within the last `--fresh` seconds; an older done belongs to the previous turn and is ignored. `shell` and `idle` never end it on freshness alone. Output is a `status` line; `--json` prints `{"row":{...},"timedOut":false}`.
- `--for tui-idle` / `--for exit`: handed to `orca terminal wait`. Output is `satisfied|timeout <repo>/<worktree> t:<handle> <mode>`; `--json` prints Orca's wait result.
- A timeout exits 2.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | OK |
| 1 | Error. stderr reads `orca-helm: ...` |
| 2 | `wait` timed out |
| 3 | Several targets (or several repos for `start`). Candidates go to stdout |

## Platform notes

**Windows.** `orca-helm.ps1` is the main entry point. It reads node's stdout as UTF-8 strings; when its own output is redirected, it writes them back in the original `[Console]::OutputEncoding` (CP949 on Korean Windows). So an outer PowerShell 5.1 that captures `$o = powershell -File .\orca-helm.ps1 status`, or pipes it on, keeps Hangul intact. Caveat: **inside** a PowerShell whose own stdout is redirected (a remote shell, for example), `$o = .\orca-helm.ps1 ...` or `.\orca-helm.ps1 ... | ConvertFrom-Json` gets nothing; the output goes straight to stdout instead. In that case start a new process, as in `$o = powershell -NoProfile -File C:\tools\orca-helm\orca-helm.ps1 status --json`, or write with `--out <file>` and read it back with `Get-Content -Encoding UTF8 <file>`. Running the command as is and reading its stdout is not affected. Set `ORCA_HELM_ENCODING=utf8` to keep UTF-8 bytes instead. stderr comes straight from node, and `wait` output appears all at once at the end. PowerShell swallows `--`, so `raw` works without it. `orca-helm.cmd` switches to `chcp 65001`, restores the previous code page, and keeps the exit code. Running `node bin\orca-helm.mjs` directly also works.

On Windows orca-helm runs the `orca.exe` next to `orca.cmd` rather than the cmd.exe wrapper, which mangles quotes. Point `ORCA_HELM_BIN` at `orca.exe` too: current Node refuses to run a `.cmd` without a shell and ends with `cannot execute ...: EINVAL`.

**macOS / Linux.** `orca-helm` is a POSIX `sh` script that follows symlinks to find itself. node writes UTF-8. On macOS, register the CLI in Orca Settings → General → Orca CLI (`/usr/local/bin/orca` on Intel, `~/.local/bin/orca` on Apple Silicon). Linux `.deb`/`.rpm` installs use `/usr/bin/orca-ide`; others use `~/.local/bin/orca-ide`.

**Finding the orca binary.** `ORCA_HELM_BIN` wins when set. Otherwise:

- Windows: `orca.exe` on PATH → `orca.exe` beside `orca.cmd` on PATH → `%LOCALAPPDATA%\Programs\Orca\bin\orca.exe`
- macOS: `orca` on PATH → `~/.local/bin/orca` → `/usr/local/bin/orca` → `/opt/homebrew/bin/orca`
- Linux: `orca-ide` on PATH → `orca` on PATH → `~/.local/bin/orca-ide` → `/usr/bin/orca-ide`

If none is found, it lists where it looked and exits 1.

**Other.** A terminal handle lives only as long as that Orca process, so every command looks handles up again. Prompt files are UTF-8; a BOM is dropped and CRLF becomes LF.

## The grokbot-notify plugin

It receives Orca's plugin alert hook `agent.status.changed` and POSTs JSON to the Grok Bot routine URL. It is the other half of the set: Grok Bot learns from these alerts when to `read`. Install and connect it with [Install](#install) steps 2 and 3.

### Behavior

- By default it hands over `done`, `waiting` and `blocked` only, never `working` (change this with the `states` setting).
- The same state for the same terminal is not sent again within `debounceSeconds` (30 by default). If another state, such as `working`, came in between, it counts as a new turn and is sent.
- A failed connection, 429 or 5xx is retried once after 2 seconds. A 10-second timeout is not retried, because Grok Bot may already have the first one. Failures show in `orca plugin logs local.grokbot-notify`.
- The worktree name and branch come from `workspace.list`; they are `null` when not found.
- The agent's last reply is not included: Orca's alert hook does not carry it. Read it with `orca-helm read <worktree> --plain`.

### The JSON it sends

```json
{
  "event": "agent.status.changed",
  "text": "fix-login: done (success) - Fix login redirect",
  "state": "done",
  "outcome": "success",
  "title": "Fix login redirect",
  "terminalId": "term_…",
  "paneKey": "tab…:leaf…",
  "workspaceId": "<repoId>::<worktree path>",
  "worktree": "fix-login",
  "branch": "fix-login",
  "repo": null,
  "receivedAt": "2026-11-03T12:00:00.000Z",
  "host": "my-pc"
}
```

- `text`: one line the routine can relay as is: `<worktree>: <state> (<outcome>) - <title>`, with `Orca` when the worktree is unknown.
- `state`: Orca's state (`done` / `waiting` / `blocked` / `working`). `outcome`: `success`, `failure` or `null`.
- `title`: the terminal title. `terminalId` is the same handle orca-helm uses, so `orca-helm read t:<terminalId>` reads that terminal directly.
- `worktree`, `branch`: the worktree's name and branch, or `null`. `repo` is always `null`; Orca does not provide it.
- `receivedAt`: when Orca received the state (ISO 8601). `host`: the PC's host name.

### Settings

They appear under the plugin in Orca **Settings**.

| Key | Shown as | Meaning |
| --- | --- | --- |
| `webhookUrl` | Grok Bot routine URL | The URL from the Grok Bot routine screen. `auth.set`'s `url` also sets it |
| `states` | States | States to hand over, comma-separated. Default `done,waiting,blocked` |
| `debounceSeconds` | Debounce seconds | Seconds before the same state is sent again. Default `30` |
| `authValue` | Authorization value | Paste once; the worker moves it into secrets right away and clears the field |

### Handlers

Call them with `orca plugin dev request <folder|local.grokbot-notify> <name>`. This reaches plugins loaded from a development folder only.

| Name | Input | Result |
| --- | --- | --- |
| `auth.set` | `{"url"?: string, "value"?: string}` (at least one) | `{"ok":true}`. `url` must be http(s) |
| `auth.status` | none | `{"hasAuth","hasUrl","protection"}`. Never the values themselves |
| `test.send` | none | Sends one test `done` alert, skipping the repeat check. `{"status":<HTTP status or null>}` |

### Secrets

- The Authorization value lives only in Orca's encrypted plugin secrets. When `protection` is `unavailable` (no OS key store, or Linux `basic_text`), storing it fails.
- The worker never writes the Authorization value or the routine URL to its log or error messages, because the URL may carry a token.

### Capabilities

| Capability | Used for |
| --- | --- |
| `agent:read` | Receiving the `agent.status.changed` alert hook |
| `workspace:read` | Looking up the worktree name and branch with `workspace.list` |
| `settings:own` | Reading its settings, saving `auth.set`'s URL, clearing the Authorization field |
| `secrets:own` | Storing and reading the Authorization value |

It asks for no terminal read or input and no agent launch. The plugin only alerts Grok Bot; the CLI does everything that changes Orca.

### Development and release

```sh
orca plugin validate .
orca plugin dev emit . agent.status.changed --data '{"workspaceId":null,"paneKey":"p1","terminalId":"t1","title":"demo","state":"done","receivedAt":1730000000000,"mainAgent":{"state":"done","outcome":"success","stateStartedAt":1730000000000}}'
npm test
```

`npm test` runs the CLI and plugin tests. The plugin tests use a local HTTP stub only.

Once a tag exists, you can also install from a Git URL such as `https://github.com/tourbut/orca-helm.git#v0.2.0` in Settings → Plugins → Install plugin. `orca plugin dev request` does not reach a plugin installed that way, so put the URL and Authorization value in the Settings fields. The directory (onorca.dev/plugins) reads `orca-plugin.json` at the root of a public repo, the `orca-plugin` topic, and the latest `vX.Y.Z` tag. The release steps are in [plugins/grokbot-notify/README.md](plugins/grokbot-notify/README.md).

Status: the plugin has been checked against a local stub and a mock Orca only. It has not yet been loaded into a real Orca and delivered to Grok Bot end to end.

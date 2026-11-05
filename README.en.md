# orca-helm

English · [한국어](README.md)

**orca-helm lets Grok Bot drive the Orca IDE running on a user's PC (Windows or macOS) remotely, without fuss.** It is one set of two parts, and you need both.

1. **The orca-helm CLI.** Grok Bot calls it as a shell command on the PC. One command each for checking Orca's state (`status`), finding and reading terminals (`find`, `read`), handing out work (`send`, `start`), and waiting for it to finish (`wait`), and answering FullOps decisions (`decisions`, `decide`).
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

Add the bots in the **Grok Bot** panel (robot icon) in Orca's right sidebar. For each bot, copy two values from its routine screen first: the **URL** and the **Authorization value**.

1. Press **Add bot**.
2. Fill in **Bot name** (such as 풀로), **Grok Bot routine URL** and **Authorization value**. The Authorization field is a password field, so the text stays hidden; an `Authorization:` prefix is fine.
3. Under **Workspaces**, tick the repos or workspaces this bot should get. The list holds the repo name of every workspace Orca has open (a workspace's own name when it is not a repo). Tick none to get every workspace.
4. Press **Save**. The card shows `Authorization saved` when it is done. The value lives only in Orca's encrypted plugin secrets and never comes back to the panel.

Use **Edit** on a card to change it, or **Delete** (press it twice to confirm). While editing, leave the Authorization field empty to keep the saved value; renaming the bot keeps it too. Never write the real URLs or Authorization values into docs or the repo.

The panel writes one line per bot into the `Routes` box in Settings. Lines from 0.3.0 show up as cards as they are, and you can still paste lines into the box yourself:

```text
bot name | workspace1,workspace2 | routine URL | Authorization value
```

Example, a different bot per repo (placeholders, not real values):

```text
# bot name | workspaces | routine URL | Authorization
풀로 | Fullops-Squad-plugin,orca-helm | <풀로 routine URL> | <풀로 Authorization value>
노리 | jevpet | <노리 routine URL> | <노리 Authorization value>
링크 | KnowsLink | <링크 routine URL> | <링크 Authorization value>
```

- On save the worker moves each line's Authorization value into Orca's encrypted plugin secrets and rewrites the line as `풀로 | Fullops-Squad-plugin,orca-helm | <URL> | (saved)`, so you never paste it again.
- An `Authorization:` prefix is fine. A new line with the same bot name replaces the old one, value included.
- Blank lines and `#` comments are allowed. A malformed line is skipped and logged with its line number and the reason only.
- Never write the real URLs or Authorization values into docs or the repo.

You can also add one line from the command line when the plugin is loaded from a development folder. `.` is the clone; elsewhere pass the folder path or `local.grokbot-notify`. Windows PowerShell 5.1 breaks the quotes inside the JSON, so escape them as `\"` or run it from PowerShell 7.3+ or Git Bash.

```sh
orca plugin dev request . auth.set --data '{"route":"풀로 | Fullops-Squad-plugin,orca-helm | <routine URL> | <Authorization value>"}'
```

With a single bot you can still fill only the `Grok Bot routine URL` and `Authorization value` fields (or `auth.set` with `{"url","value"}`). Once `Routes` has a valid line, those two fields are not used.

Check:

```sh
orca plugin dev request . auth.status   # hasAuth per route; malformed lines under errors
orca plugin dev request . test.send     # one test alert (done) to every bot's routine
orca plugin logs local.grokbot-notify   # worker log: failed deliveries, skipped lines
```

## How Grok Bot uses it

Grok Bot calls orca-helm from the PC's shell: `C:\tools\orca-helm\orca-helm.ps1 <command>` on Windows, `~/orca-helm/orca-helm <command>` on macOS.

1. `status` shows what is running.
2. `send <target> --file <prompt>` gives work to an existing terminal, or `start <repo> --name <name> --agent claude --file <prompt>` creates a worktree with a new agent.
3. It gets a plugin alert (`done` / `waiting` / `blocked`), or waits with `wait <target>`.
4. `read <target> --plain` reads the result.
5. In a FullOps repo, `send` work to the coordinator, and answer the plugin's decision alerts (`fullops.decision`) with `decide`, then tell the coordinator.

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
.\orca-helm.ps1 decisions
.\orca-helm.ps1 decide orca-helm/D003 --sha <SHA> --answer go --by shin
.\orca-helm.ps1 raw worktree ps --json
```

Output is short text by default; `--json` prints one line of JSON.

| Command | What it does |
| --- | --- |
| `status [query] [--all]` | One line per terminal; a worktree with no terminal gets one line with `t:-` (nothing to `read`, `send` or `wait`). Ordered waiting, working, done, shell, idle, unknown. Archived worktrees are left out unless `--all`. `--json` prints `{"rows":[...]}` |
| `find <query>` | Top 10, archived included. Also matches repo names and paths from `repo list`. Each line ends with `worktreeId`, `repoId`, `handle`. `--json` prints `{"matches":[...]}`, each with a `score` |
| `read <target> [--lines 40] [--screen] [--plain]` | The last N lines. `--lines 0` prints none. `--screen` passes `orca terminal read --screen`. `--plain` (alias `--strip-tui`) drops TUI borders, the input box, footers, side panels and tool lines before counting N. Content lines stay: a line with only a bracket, tables, code, diffs. `--json` prints `{"handle","status","lines","truncated"}`, plus `"plain":true` with `--plain` |
| `send <target> (--file \| --text) [--no-enter] [--interrupt] [--bypass-fullops]` | Sends the text and presses Enter unless `--no-enter`. Trailing blank lines of `--file` are dropped so Enter is not pressed twice. `--interrupt` is passed as `orca terminal send --interrupt`. The text, `--file` included, rides on orca's command line, which Windows caps at about 32,000 characters. Prints `sent <repo>/<worktree> t:<handle>` |
| `start <repo> --name <name> --agent claude\|codex (--file \| --text) [--bypass-fullops]` | Picks one repo from `repo list` and runs `orca worktree create --agent --prompt` (Orca needs `--agent` with a prompt). Prints `created <name> id:<worktreeId> repo:<repoId>`, then `t:<handle>` when the agent runs in a terminal (that agent's Chat/CLI setting in Orca decides; a chat has nothing to `read`, `send` or `wait`) |
| `wait <target> [--timeout 600] [--interval 5] [--for agent\|tui-idle\|exit] [--fresh 60]` | See [wait](#wait). Seconds |
| `decisions [repo-query] [--all]` | One line per open decision of every FullOps repo (`--all` adds closed ones): `<repo>/<decision ID>  <status>  <task key>  "<question>"  [options]  sha:<SHA>  until:<expiry>  risks:<reasons>  blocks:<waiting work>  origin:<entry point>`. `--json` prints `{"decisions":[...]}` (FullOps records plus `repo` and `repoId`). See [FullOps](#fullops) |
| `decide <[repo/]D###> --answer <answer> --by <who answered> [--sha <SHA>]` | Closes a FullOps decision. Prints `answered <repo>/<ID>: <answer>`, or `already <status> <repo>/<ID>: <earlier answer>` when it was closed already. Decision IDs are numbered per repo, so write `<repo>/D003` when several repos have that ID. `--json` prints FullOps's result plus `repo` |
| `raw [--] <args>` | Passes the args to the same orca binary and returns its exit code. The `--` is optional |
| `help`, `--help`, `--version` | Help and version |

`--out <file>` works with every command, `raw` included. It writes stdout to the file as UTF-8 without a BOM and prints nothing on stdout. stderr gets one `wrote <file>` line, and the exit code is unchanged. It combines with `--json`.

Flags that take a value accept both `--name value` and `--name=value`. A value may start with `-` (`--text "- item"`). Only a token that starts with `--` begins the next flag.

Every command but `raw` takes one positional argument at most (the target or query). Quote a query that has spaces. An extra argument is an error: the command does not run, and it exits 1 with that command's usage line on stderr (`orca-helm: unexpected argument "main" ...`).

### Finding a target

`<target>` is a handle (`t:<handle>` or the bare handle) or a name.

- An exact handle match picks that terminal.
- Otherwise it compares the repo, worktree label, branch, terminal title, handle, and `repo/worktree`. Case, spaces, `-`, `_`, `.` and `/` are ignored. Exact beats prefix, prefix beats substring, substring beats in-order letters. Hangul works.
- When the best matches are several terminals of one worktree, it picks the one with an agent.
- If more than one is still left, it prints the candidates and exits 3 (`--json` prints `{"ambiguous":[...]}`).

A `status` line looks like `fullops/main  t:<handle>  waiting  claude  "title"  12m`.

The state column is `working` / `waiting` / `done` / `shell` / `idle` / `unknown`. `permission` and `blocked` show as `waiting`; worktree `active` and `inactive` show as `idle`. A terminal with no agent is `shell`. When one `repo/worktree` label covers several worktrees (archived ones included), a `~` and a short path piece (or an id hash) tell them apart (`jevpet/jevpet~982c69f1`). In `--json`, `state` is Orca's raw value when an agent is attached.

### wait

- The target is resolved to a terminal handle once, at the start, and only that handle is polled after that. A worktree with a similar name showing up mid-wait does not change the target. A target without a terminal is an error at once; if the terminal disappears mid-wait, it exits 1 with `terminal t:<handle> (<repo>/<worktree>) is gone`.
- `--for agent` (default): re-reads every `--interval` seconds (0 means 0.25 s). It ends once the agent turns waiting/done/idle/shell after being seen working. It also ends at once on a waiting/done that changed within the last `--fresh` seconds; an older done belongs to the previous turn and is ignored. `shell` and `idle` never end it on freshness alone. Output is a `status` line; `--json` prints `{"row":{...},"timedOut":false}`.
- `--for tui-idle` / `--for exit`: handed to `orca terminal wait`. Output is `satisfied|timeout <repo>/<worktree> t:<handle> <mode>`; `--json` prints Orca's wait result, or `{"satisfied":false}` on a timeout (Orca returns none then).
- A timeout exits 2.

### FullOps

In a [FullOps](https://github.com/tourbut/Fullops-Squad-plugin) repo (one with `.fullops-squad/fullops.json`), work has to go through the coordinator so the route, `worker_done` and Run tracking stay intact.

- `send` to a FullOps worker is refused when the text is longer than 20 characters. Prompt answers such as `y` or `1` still go through. Send work to the coordinator. A worker is told apart the way FullOps does it: a worktree whose branch is a role branch from `fullops.json` `roles`, for a role other than the coordinator's (`primary_role`, else the `- coordinator 역할:` line in `orca-agents.md`). A coordinator running in a role worktree such as `fullops/coor`, and a branch with no role, are not workers.
- `start` in a FullOps repo is refused. Send the request to its coordinator instead.
- Pass `--bypass-fullops` when you really mean it. Repos without FullOps are not affected.
- `decisions` and `decide` run FullOps's `decision.py` (1.16.0 or later) with Python. orca-helm judges and checks nothing itself. `decision.py` is taken from `ORCA_HELM_FULLOPS` (the plugin folder, its `scripts` folder, or the `decision.py` path), else from the newest version in the Claude Code or Codex plugin cache (`~/.claude/plugins/cache/fullops-squad/fullops-squad/<version>`, `~/.codex/plugins/cache/...`). Python is `ORCA_HELM_PYTHON`, else `python` on Windows and `python3` elsewhere.
- `decide` records the answer as coming through the bot (`--via bot`). `--sha` is the decision's own `sha` (the `sha:` column of `decisions`, and in the alert's `reply`); a SHA-bound decision needs it. `--by` is the identity of whoever actually answered; never pick it from `allow`, and have the coordinator's `--allow` use the same identities. When `--sha` is missing or different, the decision expired, or `--by` is not an allowed responder, FullOps refuses it and orca-helm exits 1 with that reason. A late answer to a decision already closed (for example from the Orca chat) reports `already` and exits 0.
- FullOps does not watch decision records. After answering, tell the coordinator waiting on it (for example `orca-helm send <coordinator> --text "orca-helm/D003 answered: go"`).
- When FullOps's `decision.py` is missing, older than 1.16.0, or a decision record has a format `version` other than 1, it exits 4.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | OK |
| 1 | Error. stderr reads `orca-helm: ...` |
| 2 | `wait` timed out |
| 3 | Several targets (or several repos for `start`, or several repos for `decisions`/`decide`, or several repos holding the decision for `decide`). Candidates go to stdout |
| 4 | FullOps's `decision.py` is missing or older than 1.16.0, a decision record has another format version, or Python cannot be run (`ORCA_HELM_PYTHON`) |

## Platform notes

**Windows.** `orca-helm.ps1` is the main entry point. node writes stdout to a temp file as UTF-8, and the script reads it back and emits each line into the PowerShell pipeline. So `$o = .\orca-helm.ps1 status --json` and `.\orca-helm.ps1 status --json | ConvertFrom-Json` work with Hangul intact even inside a PowerShell whose stdout is redirected, such as a remote shell. An outer PowerShell that starts it as a new process, as in `$o = powershell -File .\orca-helm.ps1 status`, gets the console's code page (CP949 on Korean Windows). Set `ORCA_HELM_ENCODING=utf8` to get UTF-8 bytes instead; the console code page is restored afterwards. stderr comes straight from node, and `wait` output appears all at once at the end. PowerShell swallows `--`, so `raw` works without it. `orca-helm.cmd` switches to `chcp 65001`, restores the previous code page, and keeps the exit code. Running `node bin\orca-helm.mjs` directly also works.

On Windows orca-helm runs the `orca.exe` next to `orca.cmd` rather than the cmd.exe wrapper, which mangles quotes. Point `ORCA_HELM_BIN` at `orca.exe` too: current Node refuses to run a `.cmd` without a shell and ends with `cannot execute ...: EINVAL`.

**macOS / Linux.** `orca-helm` is a POSIX `sh` script that follows symlinks to find itself. node writes UTF-8. On macOS, register the CLI in Orca Settings → General → Orca CLI (`/usr/local/bin/orca` on Intel, `~/.local/bin/orca` on Apple Silicon). Linux `.deb`/`.rpm` installs use `/usr/bin/orca-ide`; others use `~/.local/bin/orca-ide`.

**Finding the orca binary.** `ORCA_HELM_BIN` wins when set. Otherwise:

- Windows: `orca.exe` on PATH → `%LOCALAPPDATA%\Programs\orca\resources\bin\orca.exe`
- macOS: `orca` on PATH → `~/.local/bin/orca` → `/usr/local/bin/orca` → `/opt/homebrew/bin/orca`
- Linux: `orca-ide` on PATH → `~/.local/bin/orca-ide` → `/usr/bin/orca-ide` → `orca` on PATH (last, because GNOME's `/usr/bin/orca` is the screen reader)

If none is found, it lists where it looked and exits 1.

**Other.** A terminal handle lives only as long as that Orca process, so every command looks handles up again. Prompt files are UTF-8; a BOM is dropped and CRLF becomes LF.

## The grokbot-notify plugin

It receives Orca's plugin alert hook `agent.status.changed` and POSTs JSON to the Grok Bot routine URL. It is the other half of the set: Grok Bot learns from these alerts when to `read`. Install and connect it with [Install](#install) steps 2 and 3.

### Behavior

- **Routing per bot:** an alert goes once to every `Routes` line whose workspaces match. An entry matches when it equals the repo name or the Orca workspace name (case-insensitive), or appears in the worktree path. A line with an empty workspaces field matches every workspace. When no line matches, nothing happens: no network call and no repeat bookkeeping.
- With no valid `Routes` line, the single `webhookUrl` gets every workspace, as before.
- By default it hands over `done`, `waiting` and `blocked` only, never `working` (change this with the `states` setting).
- Per bot, a terminal's state is sent only when it changes. The same state reported again (Claude Code re-reports `waiting` about every minute while it waits for input) is not sent; once that state has lasted `remindMinutes` (30 by default), the next report goes out once more as a reminder. If another state, such as `working`, came in between, it counts as a new turn and is sent. An alert that did not get through does not count as sent, so the next report of that state tries again. The record lives in the worker's memory: after Orca stops an idle worker (5 minutes with no events) or the plugin reloads, the next report goes out again.
- Per bot, a failed connection, 429 or 5xx is retried once after 2 seconds. A 10-second timeout is not retried, because Grok Bot may already have the first one. Failures show with the bot's name in `orca plugin logs local.grokbot-notify`.
- The worktree name and branch come from `workspace.list`, and the repo name from the worktree's `.git` (the main worktree's folder name, or the main repo folder that a linked worktree's `gitdir:` points to). Each is `null` when not found.
- **FullOps decisions:** when an agent of a FullOps repo reports, the open decisions of that repo (`fullops-decisions/D*.json` in its Git common directory) that belong to a task started through the bot (`origin: bot`) go once to every bot whose workspaces match. Decisions of tasks started in the Orca chat (`origin: user`) are asked in the coordinator chat first, so they are not sent. Nothing polls; a delivery that failed is tried again at the next alert, and an answered decision is forgotten. A record with a format version other than 1 is not sent and is logged. Like the repeat check, this record lives in the worker's memory. Worker questions (`question`), `escalation`, failed merges and autonomy judgments are not sent: the plugin cannot read Orca orchestration messages, so those reach a person only as the coordinator terminal's status alert or as a decision the coordinator opens.
- The agent's last reply is not included: Orca's alert hook does not carry it. Read it with `orca-helm read <repo>/<worktree> --plain`.

### The JSON it sends

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

- `text`: one line the routine can relay as is: `<repo>/<worktree>: <state> (<outcome>) - <title>`. `<repo>/<worktree>` is the label `orca-helm status` prints, so it works as a target as is. `Orca` when both are unknown.
- `state`: Orca's state (`done` / `waiting` / `blocked` / `working`). `outcome`: Orca's `mainAgent.outcome` as given (`success`, `failure`, `cancellation`, `superseded`, `interruption` or `unconfirmed`), or `null`.
- `title`: the terminal title. `terminalId` is the same handle orca-helm uses, so `orca-helm read t:<terminalId>` reads that terminal directly.
- `worktree`, `branch`, `repo`: the worktree's name, its branch and the repo folder name, or `null`.
- `route`: the bot this alert went to (the first field of its `Routes` line); `null` when sent through the single `webhookUrl`.
- `receivedAt`: when Orca received the state (ISO 8601). `host`: the PC's host name.

A FullOps decision alert has `event` `fullops.decision`. A terminal state alert (`agent.status.changed`, such as `done`) only says that terminal's agent stopped; it does not say a FullOps task finished. `fullops.decision` is a decision a person has to answer.

```json
{
  "event": "fullops.decision",
  "text": "orca-helm/D003: decision waiting - Merge the login fix? [go / hold] (risks: auth change; blocks: login merge; sha: <first 12 of SHA>; until: 2026-11-06T01:00:00+00:00)",
  "decision": {"version": 1, "id": "D003", "status": "open", "key": "login", "question": "Merge the login fix?", "options": ["go", "hold"], "blocks": "login merge", "origin": "bot", "sha": "<40-char SHA>", "risks": ["auth change"], "allow": ["shin"], "expires_at": "2026-11-06T01:00:00+00:00"},
  "reply": "orca-helm decide orca-helm/D003 --sha <40-char SHA> --answer <answer> --by <who>",
  "repo": "orca-helm",
  "worktree": "main",
  "branch": "main",
  "route": "풀로",
  "host": "my-pc"
}
```

- `decision`: the decision record as FullOps wrote it (format in FullOps's `events.md`). It holds no secrets.
- `reply`: the command that answers it. `<answer>` is one of the options, `<who>` the identity of whoever actually answered (never picked from `allow`). Tell the coordinator after answering.

### Settings

They appear under the plugin in Orca **Settings**.

| Key | Shown as | Meaning |
| --- | --- | --- |
| `routes` | Routes (one Grok Bot per line) | Usually written by the **Grok Bot** panel. Multiline, one bot per line: `bot name \| workspace1,workspace2 \| routine URL \| Authorization value`. After saving, the last field reads `(saved)`. See [Install step 3](#3-connect-the-grok-bot-routine) |
| `webhookUrl` | Grok Bot routine URL | Only while `routes` has no valid line: one routine URL for every workspace. `auth.set`'s `url` also sets it |
| `authValue` | Authorization value | Only while `routes` has no valid line: the Authorization value for that URL. Paste once; the worker moves it into secrets right away and clears the field (when it cannot, the value stays in the field and is sent from there) |
| `states` | States | States to hand over, comma-separated. Default `done,waiting,blocked` |
| `remindMinutes` | Reminder minutes | Minutes an unchanged state must last before it is sent once more as a reminder; `0` never reminds. Default `30` |

### Handlers

The Grok Bot panel calls `routes.*` through `plugin.request`. From the command line, call any of them with `orca plugin dev request <folder|local.grokbot-notify> <name>`, which reaches plugins loaded from a development folder only.

| Name | Input | Result |
| --- | --- | --- |
| `routes.list` | none | `{"routes":[{"name","url","workspaces","hasAuth"}],"workspaces":[checkbox choices],"errors":[{"line","reason"}]}`. Never an Authorization value |
| `routes.save` | `{"previousName"?, "name", "url", "workspaces": [...], "auth"?}` | The new `routes.list` answer. An empty `auth` keeps the saved value, and a rename moves it. A bad value fails with the reason only; so does a secret store that cannot be read or written, and nothing changes |
| `routes.delete` | `{"name"}` | The new `routes.list` answer. Removes that bot's line and its saved Authorization |
| `auth.set` | `{"route": "<one routes line>"}` or `{"url"?: string, "value"?: string}` | `{"ok":true}`. A `route` line is appended to `routes` and replaces an earlier line for the same name. A malformed line fails with the reason only |
| `auth.status` | none | `{"hasAuth","hasUrl","protection","routes":[{"name","workspaces","hasAuth"}],"errors":[{"line","reason"}]}`. Never the values themselves |
| `test.send` | none | One test `done` alert to every bot, skipping the workspace match and the repeat check. `{"status","routes":[{"route","status"}]}` |

### Secrets

- Authorization values live only in Orca's encrypted plugin secrets, one per bot, keyed by the bot name. When `protection` is `unavailable` (no OS key store, or Linux `basic_text`), storing fails, and that line keeps its value and is sent with it. The panel then cannot save a bot with an Authorization (Save shows the error); type the line into the Settings `Routes` box instead. A pasted `authValue` likewise stays in its field and is sent as is.
- The worker never writes an Authorization value or a routine URL to its log or error messages, because the URL may carry a token. A malformed `routes` line is logged by line number and reason only.

### Capabilities

| Capability | Used for |
| --- | --- |
| `agent:read` | Receiving the `agent.status.changed` alert hook |
| `workspace:read` | Looking up the worktree name, branch and path with `workspace.list`; the panel's workspace checkboxes |
| `settings:own` | Reading its settings, saving `auth.set`, turning Authorization values into `(saved)` or clearing the field |
| `secrets:own` | Storing and reading the Authorization value |

It asks for no terminal read or input and no agent launch. The plugin only alerts Grok Bot; the CLI does everything that changes Orca. The Grok Bot panel (`plugins/grokbot-notify/panel/routes.tsx`, a components panel) uses no capability of its own: it only asks the worker.

### Development and release

```sh
orca plugin validate .
orca plugin dev emit . agent.status.changed --data '{"workspaceId":null,"paneKey":"p1","terminalId":"t1","title":"demo","state":"done","receivedAt":1730000000000,"mainAgent":{"state":"done","outcome":"success","stateStartedAt":1730000000000}}'
npm test
orca plugin test .
orca plugin check .
```

`npm test` runs the CLI and plugin worker tests (a local HTTP stub only). `orca plugin test .` also runs `panel/routes.test.tsx`, which drives the panel and the real worker together on Orca's runtime, and `orca plugin check .` draws the panel for each scenario in `panel/routes.check.ts`. On Windows, Orca 1.4.247 fails both with `cannot import "./orca-runtime.mjs"` when the repo is on a different drive than Orca's install (C:); the official template does the same, so run them from a copy on C:.

Once a tag exists, you can also install from a Git URL such as `https://github.com/tourbut/orca-helm.git#v0.5.0` in Settings → Plugins → Install plugin. The Grok Bot panel works for a plugin installed that way too; only `orca plugin dev request` does not reach it. The directory (onorca.dev/plugins) reads `orca-plugin.json` at the root of a public repo, the `orca-plugin` topic, and the latest `vX.Y.Z` tag. To release: run `orca plugin validate .`, bump `version` in `orca-plugin.json` and `package.json`, commit and push, then tag that commit and push the tag (`git tag -a vX.Y.Z -m vX.Y.Z && git push origin vX.Y.Z`). The repo needs the `orca-plugin` topic once: `gh repo edit tourbut/orca-helm --add-topic orca-plugin`.

Status: alerts have reached Grok Bot from a real Orca (see issue #1). The Grok Bot panel has been checked only with Orca's test kit (a stand-in host), not opened in a real Orca yet.

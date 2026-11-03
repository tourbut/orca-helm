import fs from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { buildRows, classifyState, findMatches, formatRow, pickRepo, pickTarget, plainLines, sortRows, tailLines } from './core.mjs'
import { runOrca, runOrcaRaw } from './orca.mjs'

const { version: VERSION } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

const HELP = `orca-helm — lets Grok Bot drive the Orca IDE (1.4.246+) on this PC from a shell.
Agent alerts reach Grok Bot through the grokbot-notify plugin in this repo.

Usage:
  orca-helm status [query] [--all] [--json]
  orca-helm find <query> [--json]
  orca-helm read <target> [--lines 40] [--screen] [--plain] [--json]
  orca-helm send <target> (--file <utf8> | --text <text>) [--no-enter] [--interrupt] [--json]
  orca-helm start <repo-query> --name <name> [--agent claude|codex] (--file <f> | --text <t>) [--json]
  orca-helm wait <target> [--timeout 600] [--interval 5] [--for agent|tui-idle|exit] [--fresh 60] [--json]
  orca-helm raw [--] <orca args...>
  orca-helm help | --help | --version

--plain (alias --strip-tui) drops TUI chrome before --lines. --json then includes plain: true.
--out <file> writes that command's stdout as UTF-8 (no BOM) and prints nothing on stdout.
Exit: 0 ok, 1 error, 2 wait timeout, 3 ambiguous match
Pass prompts with --file (UTF-8). Handles are runtime-scoped and re-read every command.
`

let stdoutSink = process.stdout

function write(text) {
  stdoutSink.write(text)
}

function writeJson(value) {
  write(`${JSON.stringify(value)}\n`)
}

function fail(message, exitCode = 1) {
  const error = new Error(message)
  error.exitCode = exitCode
  return error
}

/** Exit 3 with candidates: `json` under --json, else one `line` each on stdout. */
function ambiguous(message, candidates, line) {
  const error = fail(message, 3)
  error.candidates = { json: candidates, lines: candidates.map(line) }
  return error
}

function candidateLine(row) {
  return `${formatRow(row)}  worktreeId=${row.worktreeId} repoId=${row.repoId}`
}

function repoLine(repo) {
  return `${repo.displayName || repo.id}  id:${repo.id}  ${repo.path || ''}`
}

async function loadRows(all) {
  const [ps, terminals] = await Promise.all([
    runOrca(['worktree', 'ps'], { json: true }),
    runOrca(['terminal', 'list'], { json: true }),
  ])
  if (ps?.truncated || terminals?.truncated) process.stderr.write('orca-helm: orca truncated the listing; some rows may be missing\n')
  return buildRows(ps, terminals, { all })
}

/** UTF-8 without BOM, LF line ends. */
function readTextFile(filePath) {
  let text
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    throw new Error(`cannot read ${filePath}: ${error.message}`)
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return text.replace(/\r\n?/g, '\n')
}

function textFrom(flags) {
  if (flags.file && flags.text !== undefined) throw fail('use either --file or --text')
  // Trailing newlines would act as an extra Enter on top of --enter.
  if (typeof flags.file === 'string') return readTextFile(flags.file).replace(/\n+$/, '')
  if (typeof flags.text === 'string') return flags.text
  throw fail('provide --file <utf8> or --text <text>')
}

function numberFlag(value, name, fallback) {
  if (value === undefined) return fallback
  if (value === true || !Number.isFinite(Number(value)) || Number(value) < 0) {
    throw fail(`--${name} must be a non-negative number`)
  }
  return Number(value)
}

function resolveRow(rows, query, needHandle) {
  const picked = pickTarget(rows, query)
  if (picked.missing) throw fail(`no match for "${query}"`)
  if (picked.ambiguous) throw ambiguous(`ambiguous match for "${query}"`, picked.ambiguous, candidateLine)
  if (needHandle && !picked.row.handle) throw fail(`no terminal for ${picked.row.repo}/${picked.row.worktree}`)
  return picked.row
}

async function statusCmd(query, flags, json) {
  let rows = await loadRows(Boolean(flags.all))
  if (query) rows = findMatches(rows, [], query).map((match) => match.row)
  rows = sortRows(rows)
  if (json) writeJson({ rows })
  else for (const row of rows) write(`${formatRow(row)}\n`)
  return 0
}

async function findCmd(query, json) {
  if (!query) throw fail('find requires a query')
  const [rows, listed] = await Promise.all([loadRows(true), runOrca(['repo', 'list'], { json: true })])
  const matches = findMatches(rows, listed?.repos ?? [], query).slice(0, 10)
  if (json) {
    writeJson({ matches: matches.map(({ row, score }) => ({ ...row, score })) })
    return 0
  }
  for (const { row } of matches) {
    write(`${candidateLine(row)} handle=${row.handle ?? ''}\n`)
  }
  return 0
}

async function readCmd(target, flags, json) {
  if (!target) throw fail('read requires a target')
  const count = numberFlag(flags.lines, 'lines', 40)
  const row = resolveRow(await loadRows(true), target, true)
  const orcaArgs = ['terminal', 'read', '--terminal', row.handle]
  if (flags.screen) orcaArgs.push('--screen')
  const read = await runOrca(orcaArgs, { json: true })
  // CLI wraps the read as { terminal: RuntimeTerminalRead }.
  const result = read?.terminal ?? read
  const plain = Boolean(flags.plain || flags['strip-tui'])
  const source = plain ? plainLines(result?.tail ?? []) : (result?.tail ?? [])
  const lines = tailLines(source, count)
  if (json) {
    const payload = {
      handle: result?.handle ?? row.handle,
      status: result?.status ?? null,
      lines,
      truncated: Boolean(result?.truncated),
    }
    if (plain) payload.plain = true
    writeJson(payload)
    return 0
  }
  if (lines.length) write(`${lines.join('\n')}\n`)
  return 0
}

async function sendCmd(target, flags, json) {
  if (!target) throw fail('send requires a target')
  const text = textFrom(flags)
  const row = resolveRow(await loadRows(true), target, true)
  const orcaArgs = ['terminal', 'send', '--terminal', row.handle, '--text', text]
  if (!flags['no-enter']) orcaArgs.push('--enter')
  if (flags.interrupt) orcaArgs.push('--interrupt')
  const result = await runOrca(orcaArgs, { json: true })
  if (json) writeJson(result)
  else write(`sent ${row.repo}/${row.worktree} t:${row.handle}\n`)
  return 0
}

async function startCmd(query, flags, json) {
  if (!query) throw fail('start requires a repo query')
  if (typeof flags.name !== 'string' || !flags.name) throw fail('start requires --name')
  if (flags.agent && flags.agent !== 'claude' && flags.agent !== 'codex') throw fail('--agent must be claude or codex')
  const text = textFrom(flags)
  const listed = await runOrca(['repo', 'list'], { json: true })
  const picked = pickRepo(listed?.repos ?? [], query)
  if (picked.missing) throw fail(`no repo match for "${query}"`)
  if (picked.ambiguous) {
    // --json lists the same text lines, as it always has for repos.
    const lines = picked.ambiguous.map(repoLine)
    throw ambiguous(`ambiguous repo for "${query}"`, lines, (line) => line)
  }
  const repo = picked.repo
  const orcaArgs = ['worktree', 'create', '--repo', `id:${repo.id}`, '--name', flags.name, '--prompt', text]
  if (flags.agent) orcaArgs.push('--agent', flags.agent)
  const result = await runOrca(orcaArgs, { json: true })
  if (json) {
    writeJson(result)
    return 0
  }
  const worktree = result?.worktree ?? {}
  const id = worktree.id || worktree.worktreeId || ''
  write(`created ${worktree.displayName || flags.name}${id ? ` id:${id}` : ''} repo:${repo.id}\n`)
  if (result?.agentTerminalHandle) write(`t:${result.agentTerminalHandle}\n`)
  return 0
}

function finishWait(raw, row, mode, json) {
  // CLI wraps the wait as { wait: RuntimeTerminalWait }.
  const result = raw?.wait ?? raw
  const satisfied = result?.satisfied !== false
  if (json) writeJson(result)
  else {
    const why = result?.blockedReason ? ` ${result.blockedReason}` : ''
    write(`${satisfied ? 'satisfied' : 'timeout'} ${row.repo}/${row.worktree} t:${row.handle} ${mode}${why}\n`)
  }
  return satisfied ? 0 : 2
}

async function waitTerminal(target, mode, timeoutSec, json) {
  const row = resolveRow(await loadRows(true), target, true)
  const timeoutMs = Math.round(timeoutSec * 1000)
  try {
    const result = await runOrca(
      ['terminal', 'wait', '--terminal', row.handle, '--for', mode, '--timeout-ms', String(timeoutMs)],
      { json: true },
    )
    return finishWait(result, row, mode, json)
  } catch (error) {
    if ((error?.parsed?.wait ?? error?.parsed)?.satisfied === false) return finishWait(error.parsed, row, mode, json)
    throw error
  }
}

async function waitCmd(target, flags, json) {
  if (!target) throw fail('wait requires a target')
  const timeoutSec = numberFlag(flags.timeout, 'timeout', 600)
  const intervalSec = numberFlag(flags.interval, 'interval', 5)
  const mode = flags.for === undefined ? 'agent' : String(flags.for)
  if (!['agent', 'tui-idle', 'exit'].includes(mode)) throw fail('--for must be agent, tui-idle, or exit')
  if (mode !== 'agent') return waitTerminal(target, mode, timeoutSec, json)

  const startedAt = Date.now()
  const deadline = startedAt + timeoutSec * 1000
  // A done/waiting state older than this window is the previous turn's; wait for a new one.
  const freshMs = numberFlag(flags.fresh, 'fresh', 60) * 1000
  const first = resolveRow(await loadRows(true), target, true)
  let row = first
  let seenWorking = false
  for (;;) {
    const kind = classifyState(row.state)
    if (kind === 'working') seenWorking = true
    const fresh = typeof row.since === 'number' && row.since >= startedAt - freshMs
    // A bare shell settles only after working was seen, same as idle (fresh shell does not count).
    const likeIdle = kind === 'idle' || kind === 'shell'
    const settled = kind === 'waiting' || kind === 'done' || likeIdle
    const ready = settled && (seenWorking || (fresh && !likeIdle))
    if (ready || Date.now() >= deadline) {
      if (json) writeJson({ row, timedOut: !ready })
      else write(`${formatRow(row)}\n`)
      return ready ? 0 : 2
    }
    const left = deadline - Date.now()
    const pause = (intervalSec > 0 ? intervalSec : 0.25) * 1000
    await delay(Math.min(left, pause))
    // Poll the handle resolved once above: a terminal that later matches the query too changes nothing.
    row = (await loadRows(true)).find((candidate) => candidate.handle === first.handle)
    if (!row) throw fail(`terminal t:${first.handle} (${first.repo}/${first.worktree}) is gone`)
  }
}

/** The command's line from HELP. */
function usageOf(cmd) {
  return HELP.split('\n').find((line) => line.startsWith(`  orca-helm ${cmd} `))?.trim()
}

async function dispatch(args) {
  const [cmd, arg] = args.positionals
  const json = Boolean(args.flags.json)
  if (args.flags.version) {
    write(`${VERSION}\n`)
    return 0
  }
  if (!cmd || args.flags.help) {
    write(HELP)
    return cmd ? 0 : 1
  }
  const usage = usageOf(cmd)
  // Every command but raw takes at most one positional; a second one is usually an unquoted query.
  const extra = cmd === 'raw' ? [] : [...args.positionals.slice(cmd === 'help' ? 1 : 2), ...args.rest]
  if (usage && extra.length) {
    process.stderr.write(`orca-helm: unexpected argument "${extra[0]}" (quote a query that has spaces)\nusage: ${usage}\n`)
    return 1
  }
  if (cmd === 'help') {
    write(HELP)
    return 0
  }
  try {
    if (cmd === 'status') return await statusCmd(arg, args.flags, json)
    if (cmd === 'find') return await findCmd(arg, json)
    if (cmd === 'read') return await readCmd(arg, args.flags, json)
    if (cmd === 'send') return await sendCmd(arg, args.flags, json)
    if (cmd === 'start') return await startCmd(arg, args.flags, json)
    if (cmd === 'wait') return await waitCmd(arg, args.flags, json)
    if (cmd === 'raw') {
      if (args.rest.length === 0) throw fail('raw requires <orca args...>')
      return await runOrcaRaw(args.rest, stdoutSink)
    }
    throw fail(`unknown command: ${cmd}`)
  } catch (error) {
    if (error?.candidates) {
      if (json) writeJson({ ambiguous: error.candidates.json })
      else for (const line of error.candidates.lines) write(`${line}\n`)
    }
    process.stderr.write(`orca-helm: ${error?.message || error}\n`)
    return Number.isInteger(error?.exitCode) ? error.exitCode : 1
  }
}

export async function main(args) {
  const outFile = args.flags.out
  const capture = outFile !== undefined
  if (capture && (typeof outFile !== 'string' || outFile === '')) {
    process.stderr.write('orca-helm: --out requires a file\n')
    return 1
  }
  const chunks = []
  if (capture) {
    stdoutSink = {
      write(chunk) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
        return true
      },
    }
  }
  let code = 1
  try {
    code = await dispatch(args)
  } finally {
    stdoutSink = process.stdout
    if (capture) {
      try {
        fs.writeFileSync(outFile, Buffer.concat(chunks))
        process.stderr.write(`wrote ${outFile}\n`)
      } catch (error) {
        process.stderr.write(`orca-helm: cannot write ${outFile}: ${error.message}\n`)
        code = 1
      }
    }
  }
  return code
}

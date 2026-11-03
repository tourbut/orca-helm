import fs from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import {
  baseName,
  bestScore,
  buildRows,
  classifyState,
  findMatches,
  formatRow,
  pickTarget,
  plainLines,
  sortRows,
  tailLines,
} from './core.mjs'
import { readTextFile, runOrca, runOrcaRaw } from './orca.mjs'

const VERSION = '0.2.0'

const HELP = `orca-helm — local Orca IDE (v1.4.246) for a bot shell

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

function candidateLine(row) {
  return `${formatRow(row)}  worktreeId=${row.worktreeId} repoId=${row.repoId}`
}

async function loadRows(all) {
  const [ps, terminals] = await Promise.all([
    runOrca(['worktree', 'ps'], { json: true }),
    runOrca(['terminal', 'list'], { json: true }),
  ])
  if (ps?.truncated || terminals?.truncated) process.stderr.write('orca-helm: orca truncated the listing; some rows may be missing\n')
  return buildRows(ps, terminals, { all })
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
  if (picked.ambiguous) {
    const error = fail(`ambiguous match for "${query}"`, 3)
    error.ambiguous = picked.ambiguous
    error.query = query
    throw error
  }
  if (needHandle && !picked.row.handle) throw fail(`no terminal for ${picked.row.repo}/${picked.row.worktree}`)
  return picked.row
}

async function statusCmd(query, flags, json) {
  let rows = sortRows(await loadRows(Boolean(flags.all)))
  if (query) rows = sortRows(findMatches(rows, [], query).map((match) => match.row))
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
    write(`${formatRow(row)}  worktreeId=${row.worktreeId} repoId=${row.repoId} handle=${row.handle ?? ''}\n`)
  }
  return 0
}

async function readCmd(target, flags, json) {
  if (!target) throw fail('read requires a target')
  const row = resolveRow(await loadRows(true), target, true)
  const orcaArgs = ['terminal', 'read', '--terminal', row.handle]
  if (flags.screen) orcaArgs.push('--screen')
  const read = await runOrca(orcaArgs, { json: true })
  // CLI wraps the read as { terminal: RuntimeTerminalRead }.
  const result = read?.terminal ?? read
  const plain = Boolean(flags.plain || flags['strip-tui'])
  const source = plain ? plainLines(result?.tail ?? []) : (result?.tail ?? [])
  const lines = tailLines(source, numberFlag(flags.lines, 'lines', 40))
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
  const ranked = []
  for (const repo of listed?.repos ?? []) {
    const score = bestScore(query, [repo.displayName, repo.id, repo.path, baseName(repo.path)])
    if (score > 0) ranked.push({ repo, score })
  }
  ranked.sort((a, b) => b.score - a.score)
  if (ranked.length === 0) throw fail(`no repo match for "${query}"`)
  const top = ranked.filter((item) => item.score === ranked[0].score)
  if (top.length > 1) {
    const error = fail(`ambiguous repo for "${query}"`, 3)
    error.repoChoices = top.map((item) => `${item.repo.displayName || item.repo.id}  id:${item.repo.id}  ${item.repo.path || ''}`)
    throw error
  }
  const repo = top[0].repo
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
  let seenWorking = false
  for (;;) {
    const row = resolveRow(await loadRows(true), target, false)
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
  }
}

async function dispatch(args) {
  const [cmd, arg] = args.positionals
  const json = Boolean(args.flags.json)
  if (args.flags.version) {
    write(`${VERSION}\n`)
    return 0
  }
  if (!cmd || cmd === 'help' || args.flags.help) {
    write(HELP)
    return cmd === 'help' || args.flags.help ? 0 : 1
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
      return runOrcaRaw(args.rest, stdoutSink)
    }
    throw fail(`unknown command: ${cmd}`)
  } catch (error) {
    if (error?.ambiguous) {
      if (json) writeJson({ ambiguous: error.ambiguous })
      else for (const row of error.ambiguous) write(`${candidateLine(row)}\n`)
      process.stderr.write(`orca-helm: ambiguous match for "${error.query}"\n`)
      return 3
    }
    if (error?.repoChoices) {
      if (json) writeJson({ ambiguous: error.repoChoices })
      else for (const line of error.repoChoices) write(`${line}\n`)
      process.stderr.write(`orca-helm: ${error.message}\n`)
      return 3
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
  return code ?? 0
}

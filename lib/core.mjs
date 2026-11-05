/** Pure helpers. No I/O. */
import { createHash } from 'node:crypto'

const BOOLEAN_FLAGS = new Set([
  'all',
  'json',
  'screen',
  'plain',
  'strip-tui',
  'no-enter',
  'interrupt',
  'bypass-fullops',
  'help',
  'version',
])
const STATE_RANK = { waiting: 0, working: 1, done: 2, shell: 3, idle: 4, unknown: 5 }

export function unwrap(obj) {
  return obj && typeof obj === 'object' && 'result' in obj ? obj.result : obj
}

// Only `--x` starts another flag, so `--text "- item"` and `--lines -1` keep their value.
function isFlagValue(token) {
  return token !== undefined && !token.startsWith('--')
}

/** Take `--out <file>` / `--out=<file>` from anywhere before `--`. A missing value is `true`. */
function peelOut(argv) {
  let out
  const kept = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--') {
      kept.push(...argv.slice(i))
      break
    }
    if (token === '--out') {
      out = isFlagValue(argv[i + 1]) ? argv[++i] : true
      continue
    }
    if (token.startsWith('--out=')) {
      out = token.slice('--out='.length)
      continue
    }
    kept.push(token)
  }
  return { out, argv: kept }
}

/** process.argv.slice(2) → { positionals, flags, rest }. `--out` works for every command, `raw` included. */
export function parseCommandLine(argv) {
  const peeled = peelOut(argv)
  const [first, second] = peeled.argv
  // PowerShell swallows `--`, so everything after `raw` is orca's argv. Drop one leading `--`.
  const args = first === 'raw'
    ? { positionals: ['raw'], flags: {}, rest: peeled.argv.slice(second === '--' ? 2 : 1) }
    : parseArgs(peeled.argv)
  if (peeled.out !== undefined) args.flags.out = peeled.out
  return args
}

export function parseArgs(argv) {
  const positionals = []
  const flags = {}
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--') {
      rest.push(...argv.slice(i + 1))
      break
    }
    if (token.startsWith('--') && token.length > 2) {
      const body = token.slice(2)
      const eq = body.indexOf('=')
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1)
        continue
      }
      if (!BOOLEAN_FLAGS.has(body) && isFlagValue(argv[i + 1])) {
        flags[body] = argv[++i]
        continue
      }
      flags[body] = true
      continue
    }
    positionals.push(token)
  }
  return { positionals, flags, rest }
}

/** Lowercase and drop spaces, - _ . and slashes. Hangul stays. */
function normalize(str) {
  return String(str ?? '').toLowerCase().replace(/[\s\-_./\\]+/g, '')
}

/** Exact > prefix > substring > subsequence. 0 means no match. */
export function fuzzyScore(query, candidate) {
  const q = normalize(query)
  const c = normalize(candidate)
  if (!q || !c) return 0
  if (c === q) return 400
  if (c.startsWith(q)) return 300
  if (c.includes(q)) return 200
  let at = 0
  for (const ch of c) {
    if (ch === q[at]) {
      at += 1
      if (at === q.length) return 100
    }
  }
  return 0
}

function bestScore(query, fields) {
  return Math.max(0, ...fields.map((field) => fuzzyScore(query, field)))
}

function repoScore(query, repo) {
  return bestScore(query, [repo.displayName, repo.id, repo.path, baseName(repo.path)])
}

function baseName(value) {
  const parts = String(value ?? '').split(/[/\\]/)
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i]) return parts[i]
  }
  return ''
}

function stripAnsi(text) {
  return String(text)
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[@-_]/g, '')
}

function oneLine(value, max) {
  const text = stripAnsi(value).replace(/\s+/g, ' ').trim()
  return max && text.length > max ? text.slice(0, max) : text
}

function groupBy(items, keyOf) {
  const groups = new Map()
  for (const item of items) {
    const key = keyOf(item)
    const list = groups.get(key)
    if (list) list.push(item)
    else groups.set(key, [item])
  }
  return groups
}

function worktreeLabel(worktree) {
  return worktree.displayName || worktree.branch || baseName(worktree.path) || worktree.worktreeId || ''
}

function agentName(agent, terminal) {
  if (typeof agent?.agentType === 'string') return agent.agentType
  if (!agent && typeof terminal?.agentIdentity === 'string' && terminal.agentIdentity) return terminal.agentIdentity
  return null
}

function rowState(worktree, terminal, agent) {
  if (agent?.state) return agent.state
  // A terminal with no joined agent is a plain shell, not the worktree's status.
  if (terminal && !agent) return 'shell'
  return worktree.status || 'unknown'
}

function makeRow(worktree, terminal, agent) {
  const agentTitle = agent?.taskTitle || agent?.conversationName || agent?.displayName || ''
  const titleSource = terminal?.title || terminal?.paneTitle || agentTitle
  const worktreeName = worktreeLabel(worktree)
  const row = {
    repo: worktree.repo || '',
    worktree: worktreeName,
    worktreeId: worktree.worktreeId,
    repoId: worktree.repoId,
    branch: terminal?.branch || worktree.branch || '',
    handle: terminal?.handle ?? null,
    title: oneLine(titleSource),
    agent: agentName(agent, terminal),
    state: rowState(worktree, terminal, agent),
    since: typeof agent?.stateStartedAt === 'number' ? agent.stateStartedAt : null,
    preview: oneLine(agent?.lastAssistantMessage || terminal?.preview || worktree.preview || '', 80),
  }
  // Original label (usually displayName), and where the worktree is for the FullOps checks. Hidden so status JSON
  // stays the same shape.
  Object.defineProperties(row, {
    matchWorktree: { value: worktreeName },
    worktreePath: { value: worktree.path || '' },
  })
  return row
}

function pathPieces(path, worktreeId) {
  const base = baseName(path)
  const dash = base.lastIndexOf('-')
  const after = dash >= 0 ? base.slice(dash + 1) : ''
  const head8 = after.length >= 8 ? after.slice(0, 8) : ''
  return {
    base,
    // Orca worktree dirs end in a long id; `.fullops-review-<32 hex>` should not be the whole suffix.
    long: after.length >= 16,
    head8,
    last12: base.length > 12 ? base.slice(-12) : base,
    id8: String(worktreeId ?? '').slice(-8),
  }
}

function chooseTails(entries) {
  const infos = entries.map((entry) => pathPieces(entry.path, entry.worktreeId))
  const counts = (key) => {
    const map = new Map()
    for (const info of infos) {
      const value = info[key]
      if (!value) continue
      map.set(value, (map.get(value) ?? 0) + 1)
    }
    return map
  }
  const baseCounts = counts('base')
  const headCounts = counts('head8')
  const lastCounts = counts('last12')
  const idCounts = counts('id8')
  const used = new Set()
  return infos.map((info, index) => {
    const options = []
    if (info.base && !info.long && baseCounts.get(info.base) === 1) options.push(info.base)
    if (info.head8 && headCounts.get(info.head8) === 1) options.push(info.head8)
    if (info.last12 && lastCounts.get(info.last12) === 1) options.push(info.last12)
    if (info.id8 && idCounts.get(info.id8) === 1) options.push(info.id8)
    let pick = options.find((value) => !used.has(value))
    if (!pick) {
      // Every piece collides: hash the id, so the label stays with its worktree when `worktree ps` reorders.
      pick = createHash('sha256').update(String(entries[index].worktreeId)).digest('hex').slice(0, 8)
      while (used.has(pick)) pick += index
    }
    used.add(pick)
    return pick
  })
}

function dedupeIdentical(rows) {
  const seen = new Set()
  const out = []
  for (const row of rows) {
    const key = `${row.worktreeId}\0${row.handle ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(row)
  }
  return out
}

function disambiguateLabels(rows, pathById) {
  for (const list of groupBy(rows, (row) => `${row.repo}/${row.worktree}`).values()) {
    const byId = new Map()
    for (const row of list) {
      if (!byId.has(row.worktreeId)) byId.set(row.worktreeId, pathById.get(row.worktreeId) || '')
    }
    if (byId.size < 2) continue
    const entries = [...byId.entries()].map(([worktreeId, path]) => ({ worktreeId, path }))
    const tails = chooseTails(entries)
    const tailById = new Map(entries.map((entry, index) => [entry.worktreeId, tails[index]]))
    for (const row of list) row.worktree = `${row.worktree}~${tailById.get(row.worktreeId)}`
  }
  return rows
}

export function buildRows(psResult, terminalListResult, opts = {}) {
  const archived = new Set()
  const byWorktree = groupBy(terminalListResult?.terminals ?? [], (terminal) => terminal.worktreeId)
  const rows = []
  const pathById = new Map()
  for (const worktree of psResult?.worktrees ?? []) {
    if (worktree.isArchived) archived.add(worktree.worktreeId)
    pathById.set(worktree.worktreeId, worktree.path || '')
    const agents = new Map((worktree.agents ?? []).map((agent) => [agent.paneKey, agent]))
    const terminals = byWorktree.get(worktree.worktreeId) ?? []
    if (terminals.length === 0) {
      rows.push(makeRow(worktree, null, worktree.agents?.[0] ?? null))
      continue
    }
    for (const terminal of terminals) {
      rows.push(makeRow(worktree, terminal, agents.get(`${terminal.tabId}:${terminal.leafId}`) ?? null))
    }
  }
  // Label with archived worktrees in, so `status` prints the label that read/send/wait (which see them) resolve.
  const labeled = disambiguateLabels(dedupeIdentical(rows), pathById)
  return opts.all ? labeled : labeled.filter((row) => !archived.has(row.worktreeId))
}

export function findMatches(rows, repos, query) {
  if (!normalize(query)) return []
  const repoScores = new Map()
  for (const repo of repos ?? []) {
    if (!repo?.id) continue
    const score = repoScore(query, repo)
    if (score > (repoScores.get(repo.id) ?? 0)) repoScores.set(repo.id, score)
  }
  const matches = []
  for (const row of rows ?? []) {
    // normalize() drops slashes, so `repo/worktree` (the status label) is scored as its own field.
    const fields = [
      row.repo,
      row.worktree,
      row.matchWorktree,
      row.branch,
      row.title,
      row.handle,
      `${row.repo}/${row.worktree}`,
    ]
    if (row.matchWorktree && row.matchWorktree !== row.worktree) fields.push(`${row.repo}/${row.matchWorktree}`)
    const score = Math.max(bestScore(query, fields), repoScores.get(row.repoId) ?? 0)
    if (score > 0) matches.push({ row, score })
  }
  matches.sort((a, b) => b.score - a.score || `${a.row.repo}/${a.row.worktree}`.localeCompare(`${b.row.repo}/${b.row.worktree}`))
  return matches
}

/** Exact handle wins. A tied worktree with one agent terminal prefers that terminal. */
export function pickTarget(rows, rawQuery) {
  // Accept the `t:<handle>` form that formatRow prints.
  const query = String(rawQuery ?? '').replace(/^t:/, '')
  const exact = (rows ?? []).filter((row) => row.handle && row.handle === query)
  if (exact.length === 1) return { row: exact[0] }
  if (exact.length > 1) return { ambiguous: exact }
  const matches = findMatches(rows, [], query)
  if (matches.length === 0) return { missing: true }
  const best = matches[0].score
  const top = matches.filter((match) => match.score === best).map((match) => match.row)
  if (top.length === 1) return { row: top[0] }
  const ids = new Set(top.map((row) => row.worktreeId))
  if (ids.size === 1) {
    // `agent` is only the type string; a joined row still has stateStartedAt.
    const withAgent = top.filter((row) => row.handle && (row.agent || typeof row.since === 'number'))
    if (withAgent.length === 1) return { row: withAgent[0] }
  }
  return { ambiguous: top }
}

/** The single best repo for `start`: { repo } | { missing } | { ambiguous: repos }. */
export function pickRepo(repos, query) {
  const ranked = (repos ?? []).map((repo) => ({ repo, score: repoScore(query, repo) })).filter((item) => item.score > 0)
  if (ranked.length === 0) return { missing: true }
  const best = Math.max(...ranked.map((item) => item.score))
  const top = ranked.filter((item) => item.score === best).map((item) => item.repo)
  return top.length === 1 ? { repo: top[0] } : { ambiguous: top }
}

/** `D003` or `<repo>/D003` → { repo, id }; null when it names no FullOps decision. */
export function parseDecisionRef(ref) {
  const match = /^(?:(.+)\/)?(D\d+)$/i.exec(String(ref ?? '').trim())
  return match ? { repo: match[1] ?? null, id: match[2].toUpperCase() } : null
}

/** One `decisions` line: `<repo>/D003  open  <key>  "<question>"  [a / b]  sha:<sha>  until:<time>  risks:<a; b>  ...`. */
export function formatDecision(repo, item) {
  const parts = [`${repo}/${item.id}`, item.status, item.key || '-', `"${oneLine(item.question ?? '').replaceAll('"', "'")}"`]
  if (item.options?.length) parts.push(`[${item.options.join(' / ')}]`)
  if (item.sha) parts.push(`sha:${item.sha}`)
  if (item.expires_at) parts.push(`until:${item.expires_at}`)
  if (item.risks?.length) parts.push(`risks:${item.risks.join('; ')}`)
  if (item.blocks) parts.push(`blocks:${oneLine(item.blocks)}`)
  if (item.origin) parts.push(`origin:${item.origin}`)
  return parts.join('  ')
}

export function classifyState(state) {
  const value = String(state ?? '').toLowerCase()
  if (value === 'working') return 'working'
  if (value === 'permission' || value === 'blocked' || value === 'waiting') return 'waiting'
  if (value === 'done') return 'done'
  if (value === 'shell') return 'shell'
  if (value === 'idle' || value === 'inactive' || value === 'active') return 'idle'
  return 'unknown'
}

export function sortRows(rows) {
  return [...rows].sort((a, b) => {
    const rank = STATE_RANK[classifyState(a.state)] - STATE_RANK[classifyState(b.state)]
    if (rank) return rank
    return `${a.repo}/${a.worktree}`.localeCompare(`${b.repo}/${b.worktree}`)
  })
}

function formatAge(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '-'
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}m`
  const hour = Math.floor(min / 60)
  if (hour < 48) return `${hour}h`
  return `${Math.floor(hour / 24)}d`
}

export function formatRow(row, now = Date.now()) {
  const age = formatAge(typeof row.since === 'number' ? now - row.since : Number.NaN)
  const title = String(row.title ?? '').replaceAll('"', "'")
  const handle = row.handle ? `t:${row.handle}` : 't:-'
  return `${row.repo}/${row.worktree}  ${handle}  ${classifyState(row.state)}  ${row.agent || '-'}  "${title}"  ${age}`
}

export function tailLines(lines, n) {
  const cleaned = (lines ?? []).map((line) => stripAnsi(line))
  let end = cleaned.length
  while (end > 0 && String(cleaned[end - 1]).trim() === '') end -= 1
  const kept = cleaned.slice(0, end)
  const count = Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : kept.length
  // slice(-0) would return every line.
  return count ? kept.slice(-count) : []
}

const VERTICAL_RE = /[\u2502\u2503\u2506\u2507\u250A\u250B\u254E\u254F\u2551]/
const HORIZONTAL_RE = /[\u2500\u2501\u2504\u2505\u2508\u2509\u254C\u254D\u2550]/
// A side panel label may carry counts or badges, never words: `│ git push origin main │` is content.
const PANEL_TEXT = /^(workers|reviews|flow|hooks|explorer|changes|terminals?|files|search|ports|agents?|sessions?|issues?|inbox|git)(?:\s+[^\s\p{L}]+){0,3}$/iu
const RECAP_LINE = /^\s*※\s*recap\s*:/i
const COMPACT_LINE = /^\s*[⏺●]\s+Compacted while idle\b/
const TOOL_LINE = /^\s*⎿/
// Added/removed lines of an edit diff: `33 -|old` (macOS) or `342 +new` (Windows).
const DIFF_LINE = /^\s*\d+ [+-]/
const NEW_ITEM = /^\s*[●⏺⎿❯›>]/
const NOISE_LINE = [
  TOOL_LINE,
  /^\s*Ran \d+ shell commands?\s*$/i,
  /^\s*Read \d+ files?,\s*ran \d+ shell commands?\s*$/i,
  /^\s*✻ \S+ for \d/,
  RECAP_LINE,
  /^\s*\(disable recaps in \/config\)\s*$/i,
  COMPACT_LINE,
  // The context meter (`23% of context  228.8k / 1M`), not prose that mentions a percentage.
  /\d+% of context\s{2,}/,
  /^\s*⏵+/,
  /^\s*✔\s*Update installed\b/,
  /^\s*[❯›>]\s*$/,
]

function isHorizontalRule(line) {
  const trimmed = String(line).trim()
  if (!trimmed) return false
  const body = trimmed.replace(/^[❯›>]\s*/, '')
  if (!body || !HORIZONTAL_RE.test(body)) return false
  // A plain rule, or one with a title in it (Claude Code puts the session name in the input box's top rule).
  return /^[\t \u2500-\u257F]+$/.test(body) || /^[\u2500-\u257F]{2,}.*[\u2500-\u257F]$/.test(body)
}

function isPromptLine(line) {
  return /^[ \t]*[❯›>]/.test(line) && !isHorizontalRule(line)
}

/** Cut from the input box's top rule (a rule with a prompt line under it) down. No input box, no cut. */
function cutInputBox(lines) {
  for (let top = lines.length - 1; top >= 0; top -= 1) {
    if (!isHorizontalRule(lines[top])) continue
    let next = top + 1
    while (next < lines.length && lines[next].trim() === '') next += 1
    if (next < lines.length && isPromptLine(lines[next])) return lines.slice(0, top)
  }
  return lines
}

function looksLikePanel(text) {
  const label = String(text).replace(/[\u2500-\u257F]/g, '').trim()
  if (!label || label.length > 40) return false
  return PANEL_TEXT.test(label)
}

function stripBorderPad(text, lead, trail) {
  let out = text
  if (lead) out = out.replace(/^[ \t]/, '')
  if (trail) out = out.replace(/[ \t]$/, '')
  return out
}

function takeMainColumn(line) {
  if (!VERTICAL_RE.test(line)) return line
  const parts = line.split(VERTICAL_RE)
  const started = parts[0].trim() === ''
  const ended = parts[parts.length - 1].trim() === ''
  let from = started ? 1 : 0
  let to = parts.length
  if (ended && to - from > 1) to -= 1
  const cells = parts.slice(from, to)
  if (cells.length === 1) {
    if (looksLikePanel(cells[0])) return ''
    if (started || ended) return stripBorderPad(cells[0], started, ended)
    return line
  }
  if (looksLikePanel(cells.slice(1).join(' '))) return stripBorderPad(cells[0], started, true)
  return line
}

function stripChrome(line) {
  let text = takeMainColumn(line)
  text = text.replace(/^(?:[\u2500-\u257F][ \t]?)+/, '')
  // Only edge borders go: box characters inside a line (code, a tree) are content.
  text = text.replace(/(?:[ \t]?[\u2500-\u257F])+$/, '')
  return text.replace(/\s+$/g, '')
}

function collapseBlanks(lines) {
  const out = []
  for (const line of lines) {
    if (line.trim() === '') {
      if (out.length === 0 || out[out.length - 1].trim() === '') continue
      out.push('')
      continue
    }
    out.push(line)
  }
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop()
  return out
}

// Recap and compaction wrap at 2 spaces. Tool lines wrap at the ⎿ text column (5+ spaces).
function continuationKind(text) {
  if (RECAP_LINE.test(text) || COMPACT_LINE.test(text)) return 'indent'
  if (TOOL_LINE.test(text)) return 'tool'
  return null
}

function isNoiseContinuation(text, kind) {
  if (NEW_ITEM.test(text) || DIFF_LINE.test(text)) return false
  if (kind === 'indent') return /^ {2}\S/.test(text)
  if (kind === 'tool') return /^ {5,}\S/.test(text)
  return false
}

/** Agent TUI screen → conversation text. Drops rules, the input box, footers, side panels, tool noise. */
export function plainLines(lines) {
  const prepared = (lines ?? []).map((line) => stripAnsi(String(line ?? '')).replace(/\s+$/g, ''))
  const kept = []
  let cont = null
  for (const line of cutInputBox(prepared)) {
    if (line.trim() === '') {
      cont = null
      kept.push('')
      continue
    }
    const text = stripChrome(line)
    // Only borders and rules were on this line. `}` or `...` alone is content and stays.
    if (text.trim() === '') {
      cont = null
      continue
    }
    if (NOISE_LINE.some((pattern) => pattern.test(text))) {
      cont = continuationKind(text)
      continue
    }
    if (cont && isNoiseContinuation(text, cont)) continue
    cont = null
    kept.push(text)
  }
  return collapseBlanks(kept)
}

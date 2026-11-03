import path from 'node:path'

const VALID_STATES = new Set(['working', 'blocked', 'waiting', 'done'])
const DEFAULT_STATES = ['done', 'waiting', 'blocked']

/** @param {unknown} str */
export function parseStates(str) {
  if (typeof str !== 'string' || str.trim() === '') {
    return new Set(DEFAULT_STATES)
  }
  const picked = str
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => VALID_STATES.has(part))
  return picked.length > 0 ? new Set(picked) : new Set(DEFAULT_STATES)
}

export function createDebouncer() {
  /** @type {Map<string, { state: string, at: number }>} */
  const last = new Map()

  /**
   * @param {string} key
   * @param {string} state
   * @param {number} nowMs
   * @param {number} windowMs
   */
  return function shouldSend(key, state, nowMs, windowMs) {
    if (last.size > 200) {
      for (const [k, entry] of last) {
        if (nowMs - entry.at > windowMs) last.delete(k)
      }
    }
    const prev = last.get(key)
    if (prev && prev.state === state && nowMs - prev.at < windowMs) {
      return false
    }
    last.set(key, { state, at: nowMs })
    return true
  }
}

const segments = (value) => String(value).replaceAll('\\', '/').split('/').filter(Boolean)

/**
 * The repo's folder name for a worktree. `.git` is a directory in the main worktree (its own folder);
 * a linked worktree's `.git` file says `gitdir: <main>/.git/worktrees/<name>` (or `<repo>.git/...` when bare).
 * @param {string} worktreePath
 * @param {string | null} gitFile the `.git` file's text, or null when `.git` is a directory
 */
export function repoNameFromGit(worktreePath, gitFile) {
  if (gitFile === null) return segments(worktreePath).at(-1) ?? null
  const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(String(gitFile))?.[1]
  if (!gitdir) return null
  const common = segments(path.resolve(worktreePath, gitdir)).slice(0, -2)
  const last = common.at(-1)
  if (last === '.git') return common.at(-2) ?? null
  return last?.replace(/\.git$/, '') || null
}

const folded = (value) => String(value ?? '').toLowerCase().replaceAll('\\', '/')

/** A route's workspaces field: lowercased entries. Empty means every workspace. */
export function parseWorkspaces(str) {
  return typeof str === 'string' ? str.split(',').map((part) => folded(part.trim())).filter(Boolean) : []
}

/** An entry equals the repo or workspace name, or appears in the worktree path (case-insensitive). */
export function matchesWorkspace(entries, { repo, name, path: worktreePath }) {
  if (entries.length === 0) return true
  const where = folded(worktreePath)
  return entries.some((entry) => entry === folded(repo) || entry === folded(name) || where.includes(entry))
}

export function isHttpUrl(url) {
  try {
    const protocol = new URL(url).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

export function stripAuthPrefix(value) {
  return String(value ?? '').replace(/^\s*authorization:\s*/i, '').trim()
}

export const SAVED = '(saved)'
const ROUTE_FORMAT = 'expected name | workspaces | URL | Authorization'

/** One `routes` line. Errors name the problem only, never a value. */
function parseRouteLine(raw) {
  const line = raw.trim()
  if (!line || line.startsWith('#')) return {}
  const parts = line.split('|').map((part) => part.trim())
  if (parts.length < 3) return { error: ROUTE_FORMAT }
  const [name, workspacesText, url] = parts
  if (!name) return { error: 'missing bot name' }
  if (!isHttpUrl(url)) return { error: 'URL is not http(s)' }
  const auth = stripAuthPrefix(parts.slice(3).join('|'))
  return {
    route: {
      key: name.toLowerCase(),
      name,
      workspacesText,
      workspaces: parseWorkspaces(workspacesText),
      url,
      saved: auth === SAVED,
      auth: auth && auth !== SAVED ? auth : null,
    },
  }
}

/**
 * The `routes` setting: one Grok Bot per line, `name | workspaces | URL | Authorization`. Blank lines and `#`
 * comments are skipped. A later line for the same name (case-insensitive) replaces the earlier one.
 * `rows` is every line to keep, in order; `errors` hold a line number and reason.
 */
export function parseRoutes(str) {
  const rows = String(str ?? '')
    .split(/\r?\n/)
    .map((raw, index) => ({ raw, number: index + 1, ...parseRouteLine(raw) }))
  const last = new Map()
  for (const row of rows) if (row.route) last.set(row.route.key, row)
  return {
    rows: rows.filter((row) => !row.route || last.get(row.route.key) === row),
    routes: [...last.values()].sort((a, b) => a.number - b.number).map((row) => row.route),
    errors: rows.filter((row) => row.error).map((row) => ({ line: row.number, reason: row.error })),
  }
}

/** The line kept in Settings once a route's Authorization is in secrets. */
export function savedRouteLine(route) {
  return `${route.name} | ${route.workspacesText} | ${route.url} | ${SAVED}`
}

/** The line the Grok Bot panel writes: `name | a,b | URL`, plus ` | (saved)` when an Authorization is stored. */
export function routeLine({ name, workspaces, url, saved }) {
  return `${name} | ${workspaces.join(',')} | ${url}${saved ? ` | ${SAVED}` : ''}`
}

/** Why the panel's route cannot be written as one line, or null. Never echoes a value. */
export function routeProblem({ name, url, workspaces }) {
  const bad = (value) => /[|\r\n]/.test(value)
  if (!text(name)) return 'enter a bot name'
  if (bad(name)) return 'a bot name cannot contain | or a line break'
  if (!isHttpUrl(text(url)) || bad(url)) return 'enter an http(s) routine URL'
  if (workspaces.some((entry) => bad(entry) || entry.includes(','))) return 'a workspace cannot contain , or |'
  return null
}

const text = (value) => String(value ?? '').trim()
const lines = (str) => String(str ?? '').replace(/\r\n/g, '\n').split('\n')
const keyOf = (raw) => parseRouteLine(raw).route?.key

/** `line` takes the place of the first line for any of `keys`; later lines for them go. With none, it is appended. */
export function upsertRouteLine(str, keys, line) {
  const out = []
  let placed = false
  for (const raw of lines(str)) {
    if (!keys.includes(keyOf(raw))) out.push(raw)
    else if (!placed) {
      out.push(line)
      placed = true
    }
  }
  while (out.length > 0 && out.at(-1).trim() === '') out.pop()
  if (!placed) out.push(line)
  return out.join('\n')
}

/** The routes text without any line for `key`. */
export function removeRouteLines(str, key) {
  return lines(str)
    .filter((raw) => keyOf(raw) !== key)
    .join('\n')
}

/** Checkbox choices for the panel: each workspace's repo name, or its own name when it has none. */
export function workspaceOptions(infos) {
  const seen = new Map()
  for (const info of infos) {
    const label = text(info.repo) || text(info.name)
    if (label && !seen.has(label.toLowerCase())) seen.set(label.toLowerCase(), label)
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b))
}

/** One line a Grok Bot routine can relay as is: `shop/main: done (success) - fix login`. */
function summary(repo, worktree, state, outcome, title) {
  const label = repo && worktree ? `${repo}/${worktree}` : worktree || repo || 'Orca'
  return `${label}: ${state ?? 'unknown'}${outcome ? ` (${outcome})` : ''}${title ? ` - ${title}` : ''}`
}

/**
 * @param {Record<string, unknown>} event
 * @param {{ worktree?: string | null, branch?: string | null, repo?: string | null, route?: string | null, host?: string | null }} extra
 */
export function buildPayload(event, { worktree, branch, repo, route, host }) {
  const mainAgent = event?.mainAgent && typeof event.mainAgent === 'object' ? event.mainAgent : null
  const state = event?.state ?? null
  const outcome = mainAgent?.outcome ?? null
  const title = event?.title ?? null
  return {
    event: 'agent.status.changed',
    text: summary(repo, worktree, state, outcome, title),
    state,
    outcome,
    title,
    terminalId: event?.terminalId ?? null,
    paneKey: event?.paneKey ?? null,
    workspaceId: event?.workspaceId ?? null,
    worktree: worktree ?? null,
    branch: branch ?? null,
    repo: repo ?? null,
    route: route ?? null,
    receivedAt: typeof event?.receivedAt === 'number' ? new Date(event.receivedAt).toISOString() : null,
    host: host ?? null,
  }
}

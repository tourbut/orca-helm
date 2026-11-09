import path from 'node:path'
import { plainLines } from '../../../lib/core.mjs'

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

const MAX_TERMINALS = 200

/**
 * Repeat check per terminal: a state goes out only when it or the terminal's tail differs from the last one. The same
 * state and tail again is held back (agents re-report `waiting` every minute or so), except once as a reminder when it
 * has lasted `remindMs`; 0 never reminds. Terminal ids are never reused, so a new terminal starts with no record.
 */
export function createDebouncer() {
  /** @type {Map<string, { state: string, tailKey: string | null, at: number, reminded: boolean }>} */
  const last = new Map()

  /**
   * @param {string} key
   * @param {string} state
   * @param {number} nowMs
   * @param {number} remindMs
   * @param {string | null} [tailKey] null when the tail is unknown, which says nothing about whether it changed
   */
  function shouldSend(key, state, nowMs, remindMs, tailKey = null) {
    const prev = last.get(key)
    if (prev?.state === state && (tailKey === null || tailKey === prev.tailKey)) {
      if (prev.reminded || !(remindMs > 0) || nowMs - prev.at < remindMs) return false
      prev.reminded = true
      return true
    }
    // Map order is insertion order, so the first key is the terminal whose state changed longest ago.
    last.delete(key)
    if (last.size >= MAX_TERMINALS) last.delete(last.keys().next().value)
    last.set(key, { state, tailKey, at: nowMs, reminded: false })
    return true
  }
  /** A delivery of `state` failed: forget it, so the next report tries again. A newer state is kept. */
  shouldSend.forget = (key, state) => {
    if (last.get(key)?.state === state) last.delete(key)
  }
  return shouldSend
}

export const text = (value) => String(value ?? '').trim()
const segments = (value) => String(value).replaceAll('\\', '/').split('/').filter(Boolean)

/**
 * The repo's folder name for a worktree. `.git` is a directory in the main worktree (its own folder);
 * a linked worktree's `.git` file says `gitdir: <main>/.git/worktrees/<name>` (or `<repo>.git/...` when bare).
 * @param {string} worktreePath
 * @param {string | null} gitFile the `.git` file's text, or null when `.git` is a directory
 */
export function repoNameFromGit(worktreePath, gitFile) {
  if (gitFile === null) return segments(worktreePath).at(-1) ?? null
  const common = gitCommonDir(worktreePath, gitFile)
  if (!common) return null
  const parts = segments(common)
  if (parts.at(-1) === '.git') return parts.at(-2) ?? null
  return parts.at(-1)?.replace(/\.git$/, '') || null
}

/**
 * The Git common directory (where FullOps keeps `fullops-decisions/`): `.git` itself, or for a linked worktree the
 * directory two levels above its `gitdir:` (`<common>/worktrees/<name>`). Same arguments as repoNameFromGit.
 */
export function gitCommonDir(worktreePath, gitFile) {
  if (gitFile === null) return path.resolve(worktreePath, '.git')
  const gitdir = /^gitdir:\s*(.+?)\s*$/m.exec(String(gitFile))?.[1]
  return gitdir ? path.resolve(worktreePath, gitdir, '..', '..') : null
}

// FullOps decision records this plugin reads (FullOps docs/events.md). A missing version is a record from before it: 1.
export const DECISION_VERSION = 1

/** A FullOps decision waiting for a person: the record as FullOps wrote it, one relayable line, and how to answer. */
export function decisionPayload(item, { repo, worktree, branch, route, host }) {
  const label = repo || worktree || 'Orca'
  const options = Array.isArray(item.options) && item.options.length ? ` [${item.options.join(' / ')}]` : ''
  // What a person needs to judge it, in the line a routine relays as is.
  const facts = [
    Array.isArray(item.risks) && item.risks.length ? `risks: ${item.risks.join(', ')}` : null,
    item.blocks ? `blocks: ${item.blocks}` : null,
    item.sha ? `sha: ${String(item.sha).slice(0, 12)}` : null,
    item.expires_at ? `until: ${item.expires_at}` : null,
  ].filter(Boolean)
  return {
    event: 'fullops.decision',
    text: `${label}/${item.id}: decision waiting - ${item.question ?? ''}${options}${facts.length ? ` (${facts.join('; ')})` : ''}`,
    decision: item,
    reply: `orca-helm decide ${label}/${item.id}${item.sha ? ` --sha ${item.sha}` : ''} --answer <answer> --by <who>`,
    repo: repo ?? null,
    worktree: worktree ?? null,
    branch: branch ?? null,
    route: route ?? null,
    host: host ?? null,
  }
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

const SAVED = '(saved)'
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

/** One `routes` line: `name | workspaces | URL`, plus ` | (saved)` when its Authorization is in secrets. */
export function routeLine({ name, workspacesText, url, saved }) {
  return `${name} | ${workspacesText} | ${url}${saved ? ` | ${SAVED}` : ''}`
}

/** Why the panel's route cannot be written as one line, or null. Never echoes a value. */
export function routeProblem({ name, url, workspaces }) {
  const bad = (value) => /[|\r\n]/.test(value)
  if (!text(name)) return 'enter a bot name'
  if (bad(name)) return 'a bot name cannot contain | or a line break'
  // Such a line would be read back as a comment: the bot would vanish with its Authorization stored.
  if (text(name).startsWith('#')) return 'a bot name cannot start with #'
  if (!isHttpUrl(text(url)) || bad(url)) return 'enter an http(s) routine URL'
  if (workspaces.some((entry) => bad(entry) || entry.includes(','))) return 'a workspace cannot contain , or |'
  return null
}

const lines =(str) => String(str ?? '').replace(/\r\n/g, '\n').split('\n')
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

const TAIL_CHARS = 1500

/**
 * shortcut: a token the terminal wrapped is matched line by line, so a short last piece can stay; rejoin lines if that shows up.
 */
export function maskSecrets(str) {
  return String(str)
    .replace(/\bBearer[ \t]+\S+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-|gh[pousr]_|github_pat_)[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/\b[a-f0-9]{32,}\b/gi, '[REDACTED]')
    // Only with mixed case and a digit: long paths and words have no such mix.
    .replace(/[A-Za-z0-9+/_-]{32,}={0,2}/g, (found) => (/[a-z]/.test(found) && /[A-Z]/.test(found) && /\d/.test(found) ? '[REDACTED]' : found))
}

/**
 * Terminal lines to the end of the conversation: no ANSI or TUI chrome (their counters would look like new output on
 * every report), secrets masked before cutting so the cut cannot hide a token's prefix, whole lines. Null when empty.
 */
export function tailText(lines) {
  const masked = maskSecrets(plainLines(lines).join('\n'))
  if (masked.length > TAIL_CHARS) return masked.slice(-TAIL_CHARS).replace(/^[^\n]*\n/, '')
  return masked || null
}

// `?` right after a word (not a ternary's ` ? `), a Korean question or request ending, or a y/n prompt.
const ASKS = /[^\s?]\?(?:\s|$)|？|(?:까요|주세요)[.!]?(?:\s|$)|[([]y\/n[)\]]/i
// Agents often add a closing note after the question, so the last line alone would miss it.
const ASK_LINES = 8

/** A hint only, by fixed rules: one of the tail's last lines asks something. False means no rule matched. */
export function tailNeedsInput(tail) {
  return String(tail ?? '').split('\n').filter((line) => line.trim()).slice(-ASK_LINES).some((line) => ASKS.test(line))
}

/**
 * @param {Record<string, unknown>} event
 * @param {{ worktree?: string | null, branch?: string | null, repo?: string | null, route?: string | null, host?: string | null, tail?: string | null }} extra
 */
export function buildPayload(event, { worktree, branch, repo, route, host, tail }) {
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
    tail: tail ?? null,
    needsInput: tailNeedsInput(tail),
  }
}

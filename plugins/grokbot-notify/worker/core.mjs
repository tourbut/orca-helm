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

/** The `workspaces` setting: lowercased entries. Empty means every workspace. */
export function parseWorkspaces(str) {
  return typeof str === 'string' ? str.split(',').map((part) => folded(part.trim())).filter(Boolean) : []
}

/** An entry equals the repo or workspace name, or appears in the worktree path (case-insensitive). */
export function matchesWorkspace(entries, { repo, name, path: worktreePath }) {
  if (entries.length === 0) return true
  const where = folded(worktreePath)
  return entries.some((entry) => entry === folded(repo) || entry === folded(name) || where.includes(entry))
}

/** One line a Grok Bot routine can relay as is: `shop/main: done (success) - fix login`. */
function summary(repo, worktree, state, outcome, title) {
  const label = repo && worktree ? `${repo}/${worktree}` : worktree || repo || 'Orca'
  return `${label}: ${state ?? 'unknown'}${outcome ? ` (${outcome})` : ''}${title ? ` - ${title}` : ''}`
}

/**
 * @param {Record<string, unknown>} event
 * @param {{ worktree?: string | null, branch?: string | null, repo?: string | null, host?: string | null }} extra
 */
export function buildPayload(event, { worktree, branch, repo, host }) {
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
    receivedAt: typeof event?.receivedAt === 'number' ? new Date(event.receivedAt).toISOString() : null,
    host: host ?? null,
  }
}

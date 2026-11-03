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

/** One line a Grok Bot routine can relay as is: `main: done (success) - fix login`. */
function summary(worktree, state, outcome, title) {
  return `${worktree || 'Orca'}: ${state ?? 'unknown'}${outcome ? ` (${outcome})` : ''}${title ? ` - ${title}` : ''}`
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
    text: summary(worktree, state, outcome, title),
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

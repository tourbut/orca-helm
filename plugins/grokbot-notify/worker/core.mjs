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

/**
 * @param {Record<string, unknown>} event
 * @param {{ worktree?: string | null, repo?: string | null, host?: string | null }} extra
 */
export function buildPayload(event, { worktree, repo, host }) {
  const mainAgent = event?.mainAgent && typeof event.mainAgent === 'object' ? event.mainAgent : null
  return {
    event: 'agent.status.changed',
    state: event?.state ?? null,
    outcome: mainAgent?.outcome ?? null,
    title: event?.title ?? null,
    terminalId: event?.terminalId ?? null,
    paneKey: event?.paneKey ?? null,
    workspaceId: event?.workspaceId ?? null,
    worktree: worktree ?? null,
    repo: repo ?? null,
    receivedAt: typeof event?.receivedAt === 'number' ? new Date(event.receivedAt).toISOString() : null,
    host: host ?? null,
  }
}

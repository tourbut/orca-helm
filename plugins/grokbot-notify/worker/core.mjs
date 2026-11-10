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
/** A terminal record lasts this long after its last new state or alert; a terminal quiet that long is reported afresh. */
export const RECORD_MS = 24 * 60 * 60_000
// Claude Code reports `waiting` about a minute after `done`, on the same screen: that is one alert, not two.
const groupOf = (state) => (state === 'waiting' ? 'done' : state)

/**
 * Repeat check per terminal, kept across worker restarts through `save()` and `saved`. A state goes out when its tail
 * differs from the last one sent for it, so done -> working -> done on the same screen stays quiet; with no tail to
 * compare (unreadable, `working`) another state in between counts as a new turn. The same state and tail reported on
 * and on goes once more as a reminder after `remindMs` without another state; 0 never reminds. Terminal ids are never
 * reused. Returns `{ send, why }`: new, changed, turn, retry or reminder when it goes, same or flap when held.
 * @param {Record<string, unknown> | null} [saved] what `save()` returned
 */
export function createDebouncer(saved = null, nowMs = Date.now()) {
  /** @type {Map<string, { state: string | null, at: number, sent: Record<string, { tailKey: string | null, at: number, reminded: boolean, failed?: boolean }> }>} */
  const last = new Map()
  for (const [key, entry] of Object.entries(saved ?? {})) {
    if (entry?.sent && typeof entry.sent === 'object' && nowMs - entry.at < RECORD_MS) last.set(key, entry)
  }

  /**
   * @param {string} key
   * @param {string} state
   * @param {number} nowMs
   * @param {number} remindMs
   * @param {string | null} [tailKey] null when the tail is unknown, which says nothing about whether it changed
   */
  function shouldSend(key, state, nowMs, remindMs, tailKey = null) {
    let entry = last.get(key)
    if (!entry || nowMs - entry.at >= RECORD_MS) entry = { state: null, at: nowMs, sent: {} }
    const moved = entry.state !== state
    const prev = entry.sent[groupOf(state)]
    const why = !prev
      ? 'new'
      : prev.failed
        ? 'retry'
        : tailKey !== null && tailKey !== prev.tailKey
          ? 'changed'
          : tailKey === null && moved
            ? 'turn'
            : !moved && !prev.reminded && remindMs > 0 && nowMs - prev.at >= remindMs
              ? 'reminder'
              : null
    if (moved || why) {
      // Map order is insertion order, so the first key is the terminal whose state changed longest ago.
      last.delete(key)
      if (last.size >= MAX_TERMINALS) last.delete(last.keys().next().value)
      entry.state = state
      entry.at = nowMs
      if (why === 'reminder') prev.reminded = true
      else if (why) entry.sent[groupOf(state)] = { tailKey: tailKey ?? prev?.tailKey ?? null, at: nowMs, reminded: false }
      last.set(key, entry)
    }
    return { send: Boolean(why), why: why ?? (moved ? 'flap' : 'same') }
  }
  /** A delivery of `state` failed: the next report of it tries again, counted as a retry. */
  shouldSend.forget = (key, state) => {
    const prev = last.get(key)?.sent[groupOf(state)]
    if (prev) prev.failed = true
  }
  /** The records still within RECORD_MS, as JSON for the plugin store. */
  shouldSend.save = (nowMs = Date.now()) => Object.fromEntries([...last].filter(([, entry]) => nowMs - entry.at < RECORD_MS))
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

/** Every string of a FullOps record masked, except the commit id a person answers with. Free text can quote anything. */
function maskRecord(value, key) {
  if (typeof value === 'string') return key === 'sha' && /^[0-9a-f]{7,40}$/i.test(value) ? value : maskSecrets(value)
  if (Array.isArray(value)) return value.map((entry) => maskRecord(entry))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, maskRecord(entry, name)]))
  return value
}

const fullopsLabel = ({ repo, worktree }) => repo || worktree || 'Orca'
const fullopsPlace = ({ repo, worktree, branch, route, host }) => ({
  repo: repo ?? null,
  worktree: worktree ?? null,
  branch: branch ?? null,
  route: route ?? null,
  host: host ?? null,
})
const shortSha = (sha) => (sha ? String(sha).slice(0, 12) : null)

/** A FullOps decision waiting for a person: the record as FullOps wrote it, one relayable line, and how to answer. */
export function decisionPayload(record, where) {
  const item = maskRecord(record)
  const label = fullopsLabel(where)
  const options = Array.isArray(item.options) && item.options.length ? ` [${item.options.join(' / ')}]` : ''
  // What a person needs to judge it, in the line a routine relays as is.
  const facts = [
    Array.isArray(item.risks) && item.risks.length ? `risks: ${item.risks.join(', ')}` : null,
    item.blocks ? `blocks: ${item.blocks}` : null,
    item.sha ? `sha: ${shortSha(item.sha)}` : null,
    item.expires_at ? `until: ${item.expires_at}` : null,
  ].filter(Boolean)
  return {
    event: 'fullops.decision',
    decisionId: `${label}/${item.id}`,
    text: `${label}/${item.id}: decision waiting - ${item.question ?? ''}${options}${facts.length ? ` (${facts.join('; ')})` : ''}`,
    decision: item,
    reply: `orca-helm decide ${label}/${item.id}${item.sha ? ` --sha ${item.sha}` : ''} --answer <answer> --by <who>`,
    ...fullopsPlace(where),
  }
}

/** A merge judged by FullOps autonomy.py. Nothing to answer: a decision, when one is needed, comes as fullops.decision. */
export function judgmentPayload(record, where) {
  const { grade, blocked, blockers, reasons, key, sha } = maskRecord({
    grade: record.grade ?? null,
    blocked: Boolean(record.blocked),
    blockers: record.blockers ?? [],
    reasons: record.reasons ?? [],
    key: record.key ?? null,
    sha: record.head ?? null,
  })
  const why = [...blockers, ...reasons].join('; ')
  return {
    event: 'fullops.judgment',
    text: `${fullopsLabel(where)}: ${key ?? 'merge'} judged ${grade}${blocked ? ', blocked' : ''}${why ? ` - ${why}` : ''}${sha ? ` (sha: ${shortSha(sha)})` : ''}`,
    grade,
    blocked,
    blockers,
    reasons,
    key,
    sha,
    ...fullopsPlace(where),
  }
}

/** A finished task the coordinator could not merge: FullOps integration.py hold. */
export function holdPayload(record, where) {
  const { key, sha, reason, owner, resume } = maskRecord({
    key: record.key || null,
    sha: record.sha || null,
    reason: record.hold.reason ?? null,
    owner: record.hold.owner ?? null,
    resume: record.hold.resume ?? null,
  })
  return {
    event: 'fullops.hold',
    text: `${fullopsLabel(where)}: ${key ?? 'merge'} on hold - ${reason ?? ''} (owner: ${owner ?? '?'}; resume: ${resume ?? '?'})`,
    key,
    sha,
    reason,
    owner,
    resume,
    ...fullopsPlace(where),
  }
}

/** A worker's `escalation` or failed `worker_done`, from Orca's orchestration messages. */
export function messagePayload(message, where) {
  const failed = message.type === 'worker_done'
  const { subject, body } = maskRecord({ subject: message.subject ?? null, body: message.body ?? null })
  return {
    event: failed ? 'fullops.failed' : 'fullops.escalation',
    text: `${fullopsLabel(where)}: ${failed ? 'worker failed' : 'escalation'}${subject ? ` - ${subject}` : ''}`,
    subject,
    // Masked before the cut, so the cut cannot hide a token's prefix.
    body: body && body.slice(0, TAIL_CHARS),
    messageId: message.id ?? null,
    sentAt: message.created_at ?? null,
    ...fullopsPlace(where),
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
 * Terminal lines as conversation text: no ANSI or TUI chrome (their counters would look like new output on every
 * report), secrets masked before any cut so a cut cannot hide a token's prefix. Null when empty.
 */
export function screenText(lines) {
  return maskSecrets(plainLines(lines).join('\n')) || null
}

/** Where the tail starts: about the last TAIL_CHARS, from a line start. */
function tailStart(text) {
  if (text.length <= TAIL_CHARS) return 0
  const newline = text.indexOf('\n', text.length - TAIL_CHARS)
  return newline === -1 ? text.length - TAIL_CHARS : newline + 1
}

/** The end of screenText, whole lines. Null when empty. */
export function tailText(lines) {
  const text = screenText(lines)
  return text && text.slice(tailStart(text))
}

// `?` right after a word (not a ternary's ` ? `), a Korean question or request ending, or a y/n prompt.
const ASKS = /[^\s?]\?(?:\s|$)|？|(?:까요|주세요)[.!]?(?:\s|$)|[([]y\/n[)\]]/i
const YES_NO = /[([]y\/n[)\]]/i
// Agents often add a closing note after the question, so the last line alone would miss it.
const ASK_LINES = 8
// An agent's reply starts with ● (⏺ in older Claude Code); tool output (⎿) is already gone.
const REPLY_START = /^[ \t]*[●⏺][ \t]/gm
const MARKER = /^\s*[●⏺❯›>]\s*/
const OPTION = /^\s*(?:[❯›>]\s*)?\d{1,2}[.)]\s+(\S.*)$/
const HEAD_CHARS = 2500

const askLines = (tail) => String(tail ?? '').split('\n').filter((line) => line.trim()).slice(-ASK_LINES)
const clip = (str, chars) => (str.length > chars ? `${str.slice(0, chars - 1)}…` : str)

/** A hint only, by fixed rules: one of the tail's last lines asks something. False means no rule matched. */
export function tailNeedsInput(tail) {
  return askLines(tail).some((line) => ASKS.test(line))
}

/** The numbered choices right after the question line, else right before it. */
function optionsAround(lines, at) {
  const run = (from, step) => {
    const found = []
    for (let i = from; i >= 0 && i < lines.length && OPTION.test(lines[i]); i += step) found.push(clip(OPTION.exec(lines[i])[1].trim(), 120))
    return step > 0 ? found : found.reverse()
  }
  const after = run(at + 1, 1)
  return after.length ? after : run(at - 1, -1)
}

/**
 * What a person needs from screenText, by fixed rules (no LLM): the tail; the question among its last lines with its
 * numbered or y/n choices; the reply's first line as a short result; and the start of that reply when the tail cut it.
 * @param {string | null} text
 */
export function screenFields(text) {
  if (!text) return { tail: null, needsInput: false, question: null, options: [], result: null, replyHead: null }
  const start = tailStart(text)
  const tail = text.slice(start)
  const lines = askLines(tail)
  const at = lines.findLastIndex((line) => ASKS.test(line))
  let reply = -1
  for (const match of text.matchAll(REPLY_START)) reply = match.index
  const replyLine = reply === -1 ? '' : text.slice(reply).split('\n', 1)[0]
  let replyHead = reply !== -1 && reply < start ? text.slice(reply, start).trimEnd() : null
  if (replyHead && replyHead.length > HEAD_CHARS) replyHead = replyHead.slice(0, replyHead.lastIndexOf('\n', HEAD_CHARS) + 1 || HEAD_CHARS).trimEnd()
  return {
    tail,
    needsInput: at !== -1,
    question: at === -1 ? null : clip(lines[at].replace(MARKER, '').trim(), 300),
    options: at === -1 ? [] : YES_NO.test(lines[at]) ? ['y', 'n'] : optionsAround(lines, at),
    result: replyLine ? clip(replyLine.replace(MARKER, '').trim(), 200) : null,
    replyHead,
  }
}

/**
 * Claude Code's start screen and nothing else: its logo line with the version, no reply and no question. A `done` like
 * that (a fresh agent, or a slash command with no reply) tells a person nothing.
 */
export function isStartScreen(text) {
  return Boolean(text) && /Claude Code v\d/.test(text) && !new RegExp(REPLY_START.source, 'm').test(text) && !tailNeedsInput(text)
}

/**
 * @param {Record<string, unknown>} event
 * @param {{ worktree?: string | null, branch?: string | null, repo?: string | null, route?: string | null, host?: string | null, screen?: string | null, eventId?: string | null, reminder?: boolean, read?: string | null }} extra
 */
export function buildPayload(event, { worktree, branch, repo, route, host, screen, eventId, reminder, read }) {
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
    ...screenFields(screen ?? null),
    eventId: eventId ?? null,
    reminder: Boolean(reminder),
    read: read ?? null,
  }
}

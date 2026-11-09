import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { runOrca } from '../../../lib/orca.mjs'
import {
  DECISION_VERSION,
  buildPayload,
  createDebouncer,
  decisionPayload,
  gitCommonDir,
  holdPayload,
  isHttpUrl,
  judgmentPayload,
  matchesWorkspace,
  messagePayload,
  parseRoutes,
  parseStates,
  removeRouteLines,
  repoNameFromGit,
  routeLine,
  routeProblem,
  stripAuthPrefix,
  tailText,
  text,
  upsertRouteLine,
  workspaceOptions,
} from './core.mjs'

const FETCH_MS = 10_000
const RETRY_MS = 2_000
const READ_MS = 3_000
const READ_LINES = 200
// The single routine from before routes; its Authorization field and secret share this key.
const SINGLE_AUTH_KEY = 'authValue'
const SENT_KEY = 'fullopsSent'
const ORCA_MS = 10_000
// Older FullOps records are history, not news: they keep their files, and a new route or install must not replay them.
const RECENT_MS = 24 * 60 * 60_000

function errText(err) {
  return err?.message ?? String(err)
}

/** Secret key for a route: ASCII whatever the bot's name is (풀로, 노리, ...). */
const routeSecretKey = (route) => `route_${createHash('sha256').update(route.key).digest('hex').slice(0, 16)}`

// Secrets and settings writes go through the documented host methods (Host API 1.0).
// Never log or throw an auth value or a routine URL: either can carry the routine's token.
async function setSecret(orca, key, value) {
  const cleaned = stripAuthPrefix(value)
  if (!cleaned) throw new Error('empty auth value')
  await orca.host.call('secrets.set', { key, value: cleaned })
}

async function getSecret(orca, key) {
  const result = await orca.host.call('secrets.get', { key })
  return typeof result?.value === 'string' && result.value ? result.value : null
}

/** Whether a secret is stored under `key`; a store that cannot be read counts as none. */
async function hasSecret(orca, key) {
  return Boolean(await getSecret(orca, key).catch(() => null))
}

/** A route's Authorization exists: still raw in its line, or `(saved)` with the secret there. */
async function hasAuth(orca, route) {
  return Boolean(route.auth) || (route.saved && (await hasSecret(orca, routeSecretKey(route))))
}

async function setSetting(orca, key, value) {
  await orca.host.call('settings.set', { key, value })
}

async function readSettings(orca) {
  const all = await orca.settings.get()
  return all && typeof all === 'object' ? all : {}
}

/**
 * Move pasted Authorization values into secrets: the single authValue field, and every routes line that
 * carries one, which is rewritten to `name | workspaces | URL | (saved)`. An earlier line for a bot that
 * a later line replaces is dropped. Bad lines stay as they are and are logged once by number and reason.
 */
async function migrateAuth(orca, seen) {
  let settings
  try {
    settings = await readSettings(orca)
  } catch (err) {
    orca.log(`could not read settings: ${errText(err)}`)
    return
  }
  if (text(settings[SINGLE_AUTH_KEY])) {
    try {
      await setSecret(orca, SINGLE_AUTH_KEY, settings[SINGLE_AUTH_KEY])
      await setSetting(orca, SINGLE_AUTH_KEY, '')
    } catch (err) {
      orca.log(`could not move authValue into secrets: ${errText(err)}`)
    }
  }

  const current = String(settings.routes ?? '').replace(/\r\n/g, '\n')
  const parsed = parseRoutes(current)
  if (current !== seen.routes) {
    seen.routes = current
    for (const { line, reason } of parsed.errors) orca.log(`routes line ${line} skipped: ${reason}`)
  }
  const kept = []
  for (const row of parsed.rows) {
    if (row.route?.auth) {
      try {
        await setSecret(orca, routeSecretKey(row.route), row.route.auth)
        kept.push(routeLine({ ...row.route, saved: true }))
        continue
      } catch (err) {
        orca.log(`could not move the routes line ${row.number} Authorization into secrets: ${errText(err)}`)
      }
    }
    kept.push(row.raw)
  }
  const next = kept.join('\n')
  if (next !== current) {
    try {
      await setSetting(orca, 'routes', next)
      seen.routes = next
    } catch (err) {
      orca.log(`could not update routes: ${errText(err)}`)
    }
  }
}

/**
 * Routes to send to. With no valid routes line, the single webhookUrl/authValue covers every workspace; an authValue
 * still in Settings (secrets unavailable) is sent as is, like a raw value in a routes line.
 */
function readRoutes(settings) {
  const routes = parseRoutes(settings.routes).routes.map((route) => ({ ...route, secretKey: routeSecretKey(route) }))
  if (routes.length > 0) return routes
  const url = text(settings.webhookUrl)
  const auth = stripAuthPrefix(settings[SINGLE_AUTH_KEY]) || null
  return isHttpUrl(url) ? [{ key: '', name: null, workspaces: [], url, saved: true, auth, secretKey: SINGLE_AUTH_KEY }] : []
}

/** A raw value still in the line (secrets unavailable), else the stored secret for `(saved)`, else none. */
async function authFor(orca, route) {
  if (route.auth) return route.auth
  if (!route.saved) return null
  try {
    return await getSecret(orca, route.secretKey)
  } catch (err) {
    orca.log(`could not read the Authorization for ${route.name ?? 'webhookUrl'}: ${errText(err)}`)
    return null
  }
}

/** Every workspace, not only the focused one; [] when the host cannot list them. */
async function listWorkspaces(orca) {
  try {
    if (!orca.host?.has?.('workspace.list')) return []
    const { workspaces } = await orca.host.call('workspace.list', {})
    return (workspaces ?? []).filter(Boolean)
  } catch {
    return []
  }
}

/** The repo's folder name from the worktree's `.git`; null when the path is not readable here (remote, removed). */
function repoOf(worktreePath) {
  if (!worktreePath) return null
  try {
    return repoNameFromGit(worktreePath, gitFileOf(worktreePath))
  } catch {
    return null
  }
}

/** The `.git` file's text, or null when `.git` is a directory (a main worktree). Throws when there is no `.git`. */
const gitFileOf = (worktreePath) => {
  const dotGit = path.join(worktreePath, '.git')
  return fs.statSync(dotGit).isDirectory() ? null : fs.readFileSync(dotGit, 'utf8')
}

const isFullOps = (worktreePath) => Boolean(worktreePath) && fs.existsSync(path.join(worktreePath, '.fullops-squad', 'fullops.json'))

/** The JSON records in a FullOps folder of the Git common directory. A half-written one is read at the next alert. */
function readRecords(dir) {
  let names = []
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith('.json'))
  } catch {
    return []
  }
  const records = []
  for (const name of names) {
    const file = path.join(dir, name)
    try {
      const item = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (item) records.push({ name: name.slice(0, -'.json'.length), item, at: fs.statSync(file).mtimeMs })
    } catch {
      continue
    }
  }
  return records
}

/**
 * What FullOps left for a person in the repo's Git common directory (its events.md): open decisions and `ask`/blocked
 * judgments of a bot-started task, and merge holds. A user-started task's decisions and judgments are asked in the
 * Orca coordinator chat first, so they are not sent; a hold names no origin, so it always is.
 */
function recordAlerts(orca, common, settings, warned) {
  const now = Date.now()
  const current = (item, what) => {
    if ((item.version ?? 1) === DECISION_VERSION) return true
    if (!warned.has(`${common}#${what}`)) orca.log(`FullOps ${what} is format version ${item.version}; update grokbot-notify to send it`)
    warned.add(`${common}#${what}`)
    return false
  }
  const alerts = []
  const decisions = readRecords(path.join(common, 'fullops-decisions')).filter(({ name }) => /^D\d+$/.test(name)).map(({ item }) => item)
  for (const item of decisions) {
    if (item.status !== 'open' || item.origin !== 'bot' || !current(item, `decision ${item.id}`)) continue
    // FullOps refuses an answer past this and asks again, in a new decision.
    if (item.expires_at && Date.parse(item.expires_at) <= now) continue
    alerts.push({ id: item.id, payload: (where) => decisionPayload(item, where) })
  }
  // A decision on the same commit already asks the person; only a block still adds something.
  const decided = new Set(decisions.filter((item) => item.sha).map((item) => `${item.key}#${item.sha}`))
  for (const { name, item, at } of readRecords(path.join(common, 'fullops-autonomy'))) {
    if (now - at > RECENT_MS || item.origin !== 'bot') continue
    const wanted = item.blocked || (item.grade === 'ask' && !decided.has(`${item.key}#${item.head}`)) || (item.grade === 'auto' && settings.fullopsAuto === true)
    if (!wanted || !current(item, `judgment ${name}`)) continue
    alerts.push({ id: `judgment:${name}:${item.grade}:${Boolean(item.blocked)}`, payload: (where) => judgmentPayload(item, where) })
  }
  for (const { name, item, at } of readRecords(path.join(common, 'fullops-integration'))) {
    if (now - at > RECENT_MS || !item.hold || typeof item.hold !== 'object' || item.integrated) continue
    alerts.push({ id: `hold:${name}`, payload: (where) => holdPayload(item, where) })
  }
  return alerts
}

const messageFields = (payload) => {
  if (payload && typeof payload === 'object') return payload
  try {
    return JSON.parse(payload) ?? {}
  } catch {
    return {}
  }
}

/**
 * This repo's recent `escalation` and failed `worker_done` messages. `inbox` only reads, so the coordinator still gets
 * its mail. `complete` is false when some message could not be read or placed, so what was sent must stay remembered.
 * shortcut: a message with no dispatch (never a supervised worker's) cannot be tied to a repo and is not sent; send it by repo if FullOps starts using those.
 */
async function messageAlerts(orca, repoId, placed, warned) {
  let messages
  try {
    ;({ messages } = await runOrca(['orchestration', 'inbox', '--limit', '100', '--full'], { timeout: ORCA_MS }))
  } catch (err) {
    if (!warned.has('inbox')) orca.log(`could not read Orca messages: ${errText(err)}`)
    warned.add('inbox')
    return { alerts: [], complete: false }
  }
  warned.delete('inbox')
  const now = Date.now()
  const alerts = []
  let complete = true
  for (const message of messages ?? []) {
    const fields = messageFields(message.payload)
    if (message.type !== 'escalation' && (message.type !== 'worker_done' || fields.outcome !== 'failed')) continue
    if (!(now - Date.parse(message.created_at) <= RECENT_MS) || !fields.dispatchId) continue
    if (!placed.has(fields.dispatchId)) {
      try {
        const { workspace } = await runOrca(['orchestration', 'worker-show', '--dispatch', fields.dispatchId], { timeout: ORCA_MS })
        placed.set(fields.dispatchId, String(workspace ?? '').split('::')[0])
      } catch {
        complete = false
        continue
      }
    }
    if (placed.get(fields.dispatchId) !== repoId) continue
    alerts.push({ id: `msg:${message.id}`, payload: (where) => messagePayload(message, where) })
  }
  return { alerts, complete }
}

/** Every workspace's repo name (or its own name) for the panel's checkboxes. */
async function listWorkspaceOptions(orca) {
  return workspaceOptions((await listWorkspaces(orca)).map((ws) => ({ name: ws.name, repo: repoOf(ws.path) })))
}

/** Name, branch, path and repo of the event's worktree. A local worktree's id is `<repoId>::<path>`. */
async function workspaceInfo(orca, workspaceId) {
  const ws = workspaceId ? (await listWorkspaces(orca)).find((w) => w.id === workspaceId) : null
  const worktreePath = ws?.path || String(workspaceId ?? '').split('::')[1] || null
  return { name: ws?.name ?? null, branch: ws?.branch ?? null, path: worktreePath, repo: repoOf(worktreePath) }
}

/** The terminal's tail, or null when it cannot be read: the alert goes without it. Output is never logged. */
async function readTail(orca, terminalId) {
  if (!terminalId || !orca.host?.has?.('terminal.read')) return null
  try {
    const { lines } = await orca.host.call('terminal.read', { terminalId, maxLines: READ_LINES }, { signal: AbortSignal.timeout(READ_MS) })
    return tailText(lines)
  } catch (err) {
    orca.log(`could not read terminal output: ${err?.code ?? err?.name}`)
    return null
  }
}

// Without whitespace, and only the end, so a resized terminal re-wrapping or scrolling the same text is not new output.
const tailKeyOf = (tail) => createHash('sha256').update(tail.replace(/\s+/g, '').slice(-500)).digest('hex')

async function post(url, body, auth) {
  const headers = { 'Content-Type': 'application/json' }
  if (auth) headers.Authorization = auth
  const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(FETCH_MS) })
  return res.status
}

// A timeout is not retried: the first POST may already have reached Grok Bot.
function shouldRetry(result) {
  if (result instanceof Error) return result.name !== 'TimeoutError'
  return result === 429 || result >= 500
}

// fetch's own messages can quote the URL's credentials or the Authorization header, so log only the kind.
const failure = (err) => err.cause?.code ?? err.name

/** POST once, and once more after RETRY_MS for a failed connection, 429 or 5xx. Logs name the bot, never its URL. */
async function deliver(orca, route, payload, auth) {
  const who = `Grok Bot routine${route.name ? ` ${route.name}` : ''}`
  const body = JSON.stringify(payload)
  const attempt = () => post(route.url, body, auth).catch((err) => (err instanceof Error ? err : new Error(String(err))))
  let result = await attempt()
  if (shouldRetry(result)) {
    orca.log(`${who} ${result instanceof Error ? `failed: ${failure(result)}` : `responded ${result}`}; retrying once`)
    await delay(RETRY_MS)
    result = await attempt()
  }
  if (result instanceof Error) {
    orca.log(`${who} failed: ${failure(result)}`)
    return null
  }
  if (result < 200 || result >= 300) orca.log(`${who} responded ${result}`)
  return result
}

/** @param {import('orca/worker').OrcaWorkerApi} orca */
export default async function activate(orca) {
  /** One repeat check per route, so bots never hold each other back. */
  const debouncers = new Map()
  const debouncerFor = (key) => debouncers.get(key) ?? debouncers.set(key, createDebouncer()).get(key)
  const seen = { routes: null }
  let warnedNoUrl = false

  await migrateAuth(orca, seen)
  // Move pasted values out of plain settings now, not at the next alert; open panels redraw.
  orca.settings.onDidChange?.(async (change) => {
    await migrateAuth(orca, seen)
    if (!change?.key || change.key === 'routes') orca.panels?.post?.('routes.changed', {})
  })

  /** `test` (test.send) goes to every route and skips the workspace match and the repeat check. */
  async function forward(event, { test = false } = {}) {
    try {
      await migrateAuth(orca, seen)
      const settings = await readSettings(orca)
      const routes = readRoutes(settings)
      if (routes.length === 0) {
        if (!warnedNoUrl) {
          orca.log('no Grok Bot routine is set (routes or webhookUrl); skipping')
          warnedNoUrl = true
        }
        return { status: null, routes: [] }
      }
      warnedNoUrl = false

      // Outside every route's workspaces nothing happens: no repeat bookkeeping, no POST.
      const needInfo = routes.some((route) => route.workspaces.length > 0)
      const info = needInfo ? await workspaceInfo(orca, event.workspaceId) : null
      const matched = test ? routes : routes.filter((route) => matchesWorkspace(route.workspaces, info ?? {}))
      if (matched.length === 0) return { status: null, routes: [] }

      const minutes = Number(settings.remindMinutes ?? 30)
      const remindMs = Math.max(0, Number.isFinite(minutes) ? minutes : 30) * 60_000
      const terminal = event.terminalId ?? event.paneKey
      const wanted = test || parseStates(settings.states).has(event.state)
      // `working` output changes all the time, so that state stays state-only even when `states` includes it.
      const tail = wanted && !test && event.state !== 'working' ? await readTail(orca, event.terminalId) : null
      const tailKey = tail && tailKeyOf(tail)
      const now = Date.now()
      // Every state is remembered per route, so done -> working -> done sends the second done.
      const fresh = matched.filter((route) => debouncerFor(route.key)(terminal, event.state, now, remindMs, tailKey))
      if (!wanted) return { status: null, routes: [] }
      const due = test ? matched : fresh
      if (due.length === 0) return { status: null, routes: [] }

      const where = info ?? (await workspaceInfo(orca, event.workspaceId))
      const results = await Promise.all(
        due.map(async (route) => {
          const payload = buildPayload(event, {
            worktree: where.name,
            branch: where.branch,
            repo: where.repo,
            route: route.name,
            host: os.hostname(),
            tail,
          })
          const status = await deliver(orca, route, payload, await authFor(orca, route))
          // An alert that did not get through was not sent: the next report of this state tries again.
          if (!test && !(status >= 200 && status < 300)) debouncerFor(route.key).forget(terminal, event.state)
          return { route: route.name, status }
        })
      )
      return { status: results[0].status, routes: results }
    } catch (err) {
      orca.log(`forward failed: ${errText(err)}`)
      return { status: null, routes: [] }
    }
  }

  /** FullOps alerts already delivered per route, as `<git common dir>#<id>`. Kept in the store: Orca stops an idle worker. */
  const announced = new Map()
  const warned = new Set()
  /** Dispatch id to repo id; a dispatch stays in its workspace. */
  const placed = new Map()
  try {
    for (const [route, keys] of Object.entries((await orca.storage.get(SENT_KEY)) ?? {})) announced.set(route, new Set(keys))
  } catch (err) {
    orca.log(`could not read the sent FullOps alerts: ${errText(err)}`)
  }
  async function saveAnnounced() {
    try {
      await orca.storage.set(SENT_KEY, Object.fromEntries([...announced].map(([route, keys]) => [route, [...keys]])))
    } catch (err) {
      orca.log(`could not save the sent FullOps alerts: ${errText(err)}`)
    }
  }

  /**
   * Issue #2: each FullOps event for a person goes once to every route whose workspaces match. Everything is read when
   * Orca reports an agent of that repo, so nothing polls; a worker that escalates or fails then settles, so messages
   * are read only when an agent settles. A failed delivery is tried again at the next report.
   */
  async function forwardFullOps(event) {
    try {
      // A local worktree's id is `<repoId>::<path>`: skip the host call for repos without FullOps.
      const [repoId, idPath] = String(event.workspaceId ?? '').split('::')
      if (idPath && !isFullOps(idPath)) return []
      const info = await workspaceInfo(orca, event.workspaceId)
      if (!isFullOps(info.path)) return []
      const settings = await readSettings(orca)
      const routes = readRoutes(settings).filter((route) => matchesWorkspace(route.workspaces, info))
      if (routes.length === 0) return []
      const common = gitCommonDir(info.path, gitFileOf(info.path))
      const alerts = recordAlerts(orca, common, settings, warned)
      let messagesRead = false
      if (idPath && event.state !== 'working') {
        const read = await messageAlerts(orca, repoId, placed, warned)
        alerts.push(...read.alerts)
        messagesRead = read.complete
      }
      const live = new Set(alerts.map((alert) => `${common}#${alert.id}`))
      const results = []
      let changed = false
      for (const route of routes) {
        const sent = announced.get(route.key) ?? announced.set(route.key, new Set()).get(route.key)
        for (const key of sent) {
          // Closed or aged out since. Messages not read this time are not known to be gone.
          if (key.startsWith(`${common}#`) && !live.has(key) && (messagesRead || !key.startsWith(`${common}#msg:`))) {
            sent.delete(key)
            changed = true
          }
        }
        for (const alert of alerts) {
          const key = `${common}#${alert.id}`
          if (sent.has(key)) continue
          sent.add(key)
          const payload = alert.payload({ repo: info.repo, worktree: info.name, branch: info.branch, route: route.name, host: os.hostname() })
          const status = await deliver(orca, route, payload, await authFor(orca, route))
          if (status >= 200 && status < 300) changed = true
          else sent.delete(key)
          results.push({ route: route.name, alert: alert.id, status })
        }
      }
      if (changed) await saveAnnounced()
      return results
    } catch (err) {
      orca.log(`FullOps alert forward failed: ${errText(err)}`)
      return []
    }
  }

  orca.events.on('agent.status.changed', async (event) => {
    const result = await forward(event)
    await forwardFullOps(event)
    return result
  })

  if (orca.panels?.handle) {
    /** What the Grok Bot panel draws. Authorization values never leave the worker: only hasAuth. */
    async function panelState() {
      await migrateAuth(orca, seen)
      const settings = await readSettings(orca)
      const parsed = parseRoutes(settings.routes)
      const routes = []
      for (const route of parsed.routes) {
        const workspaces = route.workspacesText.split(',').map(text).filter(Boolean)
        routes.push({ name: route.name, url: route.url, workspaces, hasAuth: await hasAuth(orca, route) })
      }
      return { routes, workspaces: await listWorkspaceOptions(orca), errors: parsed.errors }
    }

    orca.panels.handle('routes.list', () => panelState())

    // { previousName, name, url, workspaces, auth }: auth empty keeps the stored value (renames move it).
    orca.panels.handle('routes.save', async (input = {}) => {
      const route = {
        name: text(input.name),
        url: text(input.url),
        workspaces: (Array.isArray(input.workspaces) ? input.workspaces : []).map(text).filter(Boolean),
      }
      const problem = routeProblem(route)
      if (problem) throw new Error(problem)
      const settings = await readSettings(orca)
      const routes = parseRoutes(settings.routes).routes
      const key = route.name.toLowerCase()
      const previousKey = text(input.previousName).toLowerCase() || key
      if (routes.some((other) => other.key === key && other.key !== previousKey)) throw new Error('another bot already has this name')

      // The edited line's own Authorization (raw in the line, or the stored one for `(saved)`). A store that cannot
      // be read or written fails the save before anything is written, so no value is dropped or deleted.
      const previous = routes.find((other) => other.key === previousKey)
      const auth = stripAuthPrefix(input.auth) || previous?.auth || (previous?.saved ? await getSecret(orca, routeSecretKey(previous)) : null)
      if (auth) await setSecret(orca, routeSecretKey({ key }), auth)
      const line = routeLine({ ...route, workspacesText: route.workspaces.join(','), saved: Boolean(auth) })
      await setSetting(orca, 'routes', upsertRouteLine(settings.routes, [previousKey, key], line))
      if (previousKey !== key) await orca.host.call('secrets.delete', { key: routeSecretKey({ key: previousKey }) }).catch(() => {})
      return panelState()
    })

    orca.panels.handle('routes.delete', async (input = {}) => {
      const key = text(input.name).toLowerCase()
      if (!key) throw new Error('enter a bot name')
      const settings = await readSettings(orca)
      await setSetting(orca, 'routes', removeRouteLines(settings.routes, key))
      await orca.host.call('secrets.delete', { key: routeSecretKey({ key }) }).catch(() => {})
      return panelState()
    })

    // Values copied from the Grok Bot routine screen: { route: "name | workspaces | URL | Authorization" },
    // or { url, value } for the single webhookUrl/authValue.
    orca.panels.handle('auth.set', async ({ route, url, value } = {}) => {
      if (route === undefined && url === undefined && value === undefined) throw new Error('provide route, or url and/or value')
      if (route !== undefined) {
        const line = String(route).trim()
        const { routes, errors } = parseRoutes(line)
        if (errors.length > 0 || routes.length !== 1) throw new Error(errors[0]?.reason ?? 'expected one routes line')
        const settings = await readSettings(orca)
        const current = String(settings.routes ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '')
        // Appended last, so it replaces an earlier line for the same bot.
        await setSetting(orca, 'routes', current ? `${current}\n${line}` : line)
        await migrateAuth(orca, seen)
      }
      if (url !== undefined) {
        const cleaned = text(url)
        if (!isHttpUrl(cleaned)) throw new Error('url must be an http(s) URL')
        await setSetting(orca, 'webhookUrl', cleaned)
      }
      if (value !== undefined) {
        await setSecret(orca, SINGLE_AUTH_KEY, value)
        try {
          await setSetting(orca, SINGLE_AUTH_KEY, '')
        } catch {
          // setting may already be empty
        }
      }
      return { ok: true }
    })

    orca.panels.handle('auth.status', async () => {
      const settings = await readSettings(orca)
      const parsed = parseRoutes(settings.routes)
      const routes = []
      for (const route of parsed.routes) {
        routes.push({ name: route.name, workspaces: route.workspacesText, hasAuth: await hasAuth(orca, route) })
      }
      let protection = null
      try {
        if (orca.host?.has?.('secrets.protection')) {
          const result = await orca.host.call('secrets.protection', {})
          protection = result?.status ?? null
        }
      } catch {
        protection = null
      }
      return {
        hasAuth: await hasSecret(orca, SINGLE_AUTH_KEY),
        hasUrl: isHttpUrl(text(settings.webhookUrl)),
        protection,
        routes,
        errors: parsed.errors,
      }
    })

    orca.panels.handle('test.send', async () => {
      const now = Date.now()
      return forward(
        {
          workspaceId: null,
          paneKey: 'test.send',
          terminalId: 'test.send',
          title: 'test.send',
          state: 'done',
          receivedAt: now,
          mainAgent: { state: 'done', outcome: 'success', stateStartedAt: now },
        },
        { test: true }
      )
    })
  }
}

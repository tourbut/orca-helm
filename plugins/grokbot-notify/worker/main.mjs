import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { parseStates, createDebouncer, buildPayload, repoNameFromGit } from './core.mjs'

const SECRET_KEY = 'authValue'
const FETCH_MS = 10_000
const RETRY_MS = 2_000

function stripAuthPrefix(value) {
  return String(value).replace(/^\s*authorization:\s*/i, '').trim()
}

function isHttpUrl(url) {
  try {
    const protocol = new URL(url).protocol
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

function errText(err) {
  return err?.message ?? String(err)
}

// Secrets and settings writes go through the documented host methods (Host API 1.0).
// Never log or throw the auth value or the routine URL: either can carry the routine's token.
async function setAuthSecret(orca, value) {
  const cleaned = stripAuthPrefix(value)
  if (!cleaned) throw new Error('empty auth value')
  await orca.host.call('secrets.set', { key: SECRET_KEY, value: cleaned })
}

async function getAuthSecret(orca) {
  const result = await orca.host.call('secrets.get', { key: SECRET_KEY })
  return typeof result?.value === 'string' && result.value ? result.value : null
}

async function clearAuthSetting(orca) {
  await orca.host.call('settings.set', { key: 'authValue', value: '' })
}

/** Move a pasted `authValue` setting into secrets and blank the field. */
async function migrateAuth(orca) {
  try {
    const raw = await orca.settings.get('authValue')
    if (raw == null || String(raw).trim() === '') return
    await setAuthSecret(orca, String(raw))
    await clearAuthSetting(orca)
  } catch (err) {
    orca.log(`could not move authValue into secrets: ${errText(err)}`)
  }
}

/** Name and branch of the event's worktree from every workspace, not only the focused one. */
async function lookupWorkspace(orca, workspaceId) {
  try {
    if (!workspaceId || !orca.host?.has?.('workspace.list')) return null
    const { workspaces } = await orca.host.call('workspace.list', {})
    return (workspaces ?? []).find((ws) => ws.id === workspaceId) ?? null
  } catch {
    return null
  }
}

/** The repo's folder name from the worktree's `.git`; null when the path is not readable here (remote, removed). */
function repoOf(worktreePath) {
  if (!worktreePath) return null
  try {
    const dotGit = path.join(worktreePath, '.git')
    return repoNameFromGit(worktreePath, fs.statSync(dotGit).isDirectory() ? null : fs.readFileSync(dotGit, 'utf8'))
  } catch {
    return null
  }
}

/** Name, branch, path and repo of the event's worktree. A local worktree's id is `<repoId>::<path>`. */
async function workspaceInfo(orca, workspaceId) {
  const ws = await lookupWorkspace(orca, workspaceId)
  const worktreePath = ws?.path || String(workspaceId ?? '').split('::')[1] || null
  return { name: ws?.name ?? null, branch: ws?.branch ?? null, path: worktreePath, repo: repoOf(worktreePath) }
}

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

/** POST once, and once more after RETRY_MS for a failed connection, 429 or 5xx. */
async function deliver(orca, url, payload, auth) {
  const body = JSON.stringify(payload)
  const attempt = () => post(url, body, auth).catch((err) => (err instanceof Error ? err : new Error(String(err))))
  let result = await attempt()
  if (shouldRetry(result)) {
    orca.log(`Grok Bot routine ${result instanceof Error ? `failed: ${errText(result)}` : `responded ${result}`}; retrying once`)
    await delay(RETRY_MS)
    result = await attempt()
  }
  if (result instanceof Error) throw result
  if (result < 200 || result >= 300) orca.log(`Grok Bot routine responded ${result}`)
  return result
}

/** @param {import('orca/worker').OrcaWorkerApi} orca */
export default async function activate(orca) {
  const shouldSend = createDebouncer()
  let warnedNoUrl = false

  await migrateAuth(orca)
  // Move a pasted value out of plain settings now, not at the next alert.
  orca.settings.onDidChange?.(() => migrateAuth(orca))

  async function forward(event, { debounce = true } = {}) {
    try {
      await migrateAuth(orca)

      const seconds = Number((await orca.settings.get('debounceSeconds')) ?? 30)
      const windowMs = Math.max(0, Number.isFinite(seconds) ? seconds : 30) * 1000
      // Every state is remembered, so done -> working -> done sends the second done.
      const fresh = shouldSend(event.terminalId ?? event.paneKey, event.state, Date.now(), windowMs)
      const allowed = parseStates(await orca.settings.get('states'))
      if (!allowed.has(event.state) || (debounce && !fresh)) return { status: null }

      const url = String((await orca.settings.get('webhookUrl')) ?? '').trim()
      if (!isHttpUrl(url)) {
        if (!warnedNoUrl) {
          orca.log('Grok Bot routine URL (webhookUrl) is empty or not http(s); skipping')
          warnedNoUrl = true
        }
        return { status: null }
      }
      warnedNoUrl = false

      const info = await workspaceInfo(orca, event.workspaceId)
      const payload = buildPayload(event, { worktree: info.name, branch: info.branch, repo: info.repo, host: os.hostname() })

      let auth = null
      try {
        auth = await getAuthSecret(orca)
      } catch (err) {
        orca.log(`could not read auth secret: ${errText(err)}`)
      }

      return { status: await deliver(orca, url, payload, auth) }
    } catch (err) {
      orca.log(`forward failed: ${errText(err)}`)
      return { status: null }
    }
  }

  orca.events.on('agent.status.changed', (event) => forward(event))

  if (orca.panels?.handle) {
    // Values copied from the Grok Bot routine screen: { url, value } (either or both).
    orca.panels.handle('auth.set', async ({ url, value } = {}) => {
      if (url === undefined && value === undefined) throw new Error('provide url and/or value')
      if (url !== undefined) {
        const cleaned = String(url).trim()
        if (!isHttpUrl(cleaned)) throw new Error('url must be an http(s) URL')
        await orca.host.call('settings.set', { key: 'webhookUrl', value: cleaned })
      }
      if (value !== undefined) {
        await setAuthSecret(orca, value)
        try {
          await clearAuthSetting(orca)
        } catch {
          // setting may already be empty
        }
      }
      return { ok: true }
    })

    orca.panels.handle('auth.status', async () => {
      let hasAuth = false
      try {
        hasAuth = Boolean(await getAuthSecret(orca))
      } catch {
        hasAuth = false
      }
      const hasUrl = isHttpUrl(String((await orca.settings.get('webhookUrl')) ?? '').trim())
      let protection = null
      try {
        if (orca.host?.has?.('secrets.protection')) {
          const result = await orca.host.call('secrets.protection', {})
          protection = result?.status ?? null
        }
      } catch {
        protection = null
      }
      return { hasAuth, hasUrl, protection }
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
        { debounce: false }
      )
    })
  }
}

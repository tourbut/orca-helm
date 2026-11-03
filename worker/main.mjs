import os from 'node:os'
import { parseStates, createDebouncer, buildPayload } from './core.mjs'

const SECRET_KEY = 'authValue'
const FETCH_MS = 10_000

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

async function migrateAuth(orca) {
  const raw = await orca.settings.get('authValue')
  if (raw == null || String(raw).trim() === '') return
  await setAuthSecret(orca, String(raw))
  await clearAuthSetting(orca)
}

async function readWorktree(orca, event) {
  try {
    if (!orca.host?.has?.('workspace.readContext')) return { worktree: null, repo: null }
    const ctx = await orca.host.call('workspace.readContext', {})
    if (!ctx || !event.terminalId) return { worktree: null, repo: null }
    const found = (ctx.terminals ?? []).some((t) => t.id === event.terminalId)
    if (!found) return { worktree: null, repo: null }
    return { worktree: ctx.displayName ?? null, repo: null }
  } catch {
    return { worktree: null, repo: null }
  }
}

async function postWebhook(orca, url, payload, auth) {
  const headers = { 'Content-Type': 'application/json' }
  if (auth) headers.Authorization = auth
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(FETCH_MS),
  })
  if (res.status < 200 || res.status >= 300) {
    orca.log(`webhook responded ${res.status}`)
  }
  return res.status
}

/** @param {import('orca/worker').OrcaWorkerApi} orca */
export default async function activate(orca) {
  const shouldSend = createDebouncer()
  let warnedNoUrl = false

  try {
    await migrateAuth(orca)
  } catch (err) {
    orca.log(`could not move authValue into secrets: ${errText(err)}`)
  }

  async function forward(event, { debounce = true } = {}) {
    try {
      try {
        await migrateAuth(orca)
      } catch (err) {
        orca.log(`could not move authValue into secrets: ${errText(err)}`)
      }

      const allowed = parseStates(await orca.settings.get('states'))
      if (!allowed.has(event.state)) return { status: null }

      const key = event.terminalId ?? event.paneKey
      const seconds = Number(await orca.settings.get('debounceSeconds') ?? 30)
      const windowMs = Math.max(0, Number.isFinite(seconds) ? seconds : 30) * 1000
      if (debounce && !shouldSend(key, event.state, Date.now(), windowMs)) {
        return { status: null }
      }

      const url = String((await orca.settings.get('webhookUrl')) ?? '').trim()
      if (!isHttpUrl(url)) {
        if (!warnedNoUrl) {
          orca.log('webhookUrl is empty or not http(s); skipping')
          warnedNoUrl = true
        }
        return { status: null }
      }
      warnedNoUrl = false

      const { worktree, repo } = await readWorktree(orca, event)
      const payload = buildPayload(event, { worktree, repo, host: os.hostname() })

      let auth = null
      try {
        auth = await getAuthSecret(orca)
      } catch (err) {
        orca.log(`could not read auth secret: ${errText(err)}`)
      }

      return { status: await postWebhook(orca, url, payload, auth) }
    } catch (err) {
      orca.log(`forward failed: ${errText(err)}`)
      return { status: null }
    }
  }

  orca.events.on('agent.status.changed', async (event) => {
    try {
      await forward(event)
    } catch (err) {
      orca.log(`handler failed: ${errText(err)}`)
    }
  })

  if (orca.panels?.handle) {
    orca.panels.handle('auth.set', async ({ value }) => {
      await setAuthSecret(orca, value ?? '')
      try {
        await clearAuthSetting(orca)
      } catch {
        // setting may already be empty
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
      let protection = null
      try {
        if (orca.host?.has?.('secrets.protection')) {
          const result = await orca.host.call('secrets.protection', {})
          protection = result?.status ?? null
        }
      } catch {
        protection = null
      }
      return { hasAuth, protection }
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

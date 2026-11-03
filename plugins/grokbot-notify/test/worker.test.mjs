import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import activate from '../worker/main.mjs'

/** A main repo `shop` and a linked worktree `wt/main` whose .git file points back to it. */
function gitFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grokbot-notify-'))
  const gitdir = path.join(root, 'shop', '.git', 'worktrees', 'main')
  fs.mkdirSync(gitdir, { recursive: true })
  fs.mkdirSync(path.join(root, 'wt', 'main'), { recursive: true })
  fs.writeFileSync(path.join(root, 'wt', 'main', '.git'), `gitdir: ${gitdir}\n`)
  return { root, worktree: path.join(root, 'wt', 'main'), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) }
}

/** Local stub for the Grok Bot routine: answers each POST with the next status. */
async function startStub(statuses) {
  const received = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      received.push({ auth: req.headers.authorization, body: JSON.parse(body) })
      res.statusCode = statuses.shift() ?? 200
      res.end()
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${server.address().port}/hook?token=t0ken`, received, close: () => server.close() }
}

function mockOrca(workspaces = []) {
  const settings = { states: 'done,waiting,blocked', debounceSeconds: 30, webhookUrl: '', authValue: '' }
  const secrets = {}
  const handlers = {}
  const logs = []
  let listener = null
  let onSettings = null
  const orca = {
    log: (message) => logs.push(message),
    settings: { get: async (key) => settings[key], onDidChange: (fn) => (onSettings = fn) },
    events: { on: (_event, fn) => (listener = fn) },
    panels: { handle: (name, fn) => (handlers[name] = fn) },
    host: {
      has: (method) => method === 'workspace.list' || method === 'secrets.protection',
      call: async (method, params) => {
        if (method === 'secrets.get') return { value: secrets[params.key] ?? null }
        if (method === 'secrets.set') return void (secrets[params.key] = params.value)
        if (method === 'settings.set') return void (settings[params.key] = params.value)
        if (method === 'secrets.protection') return { status: 'os-keyring' }
        if (method === 'workspace.list') return { workspaces }
        throw new Error(`unexpected ${method}`)
      },
    },
  }
  return { orca, settings, secrets, handlers, logs, emit: (event) => listener(event), changeSettings: () => onSettings() }
}

test('worker forwards done/waiting/blocked to the routine once, with auth, and retries a 503', async () => {
  const stub = await startStub([200, 200, 503, 200])
  const git = gitFixture()
  const { orca, settings, secrets, handlers, logs, emit, changeSettings } = mockOrca([
    { id: 'wt1', kind: 'worktree', name: 'main', branch: 'main', path: git.worktree },
  ])
  try {
    await activate(orca)
    assert.deepEqual(await handlers['auth.set']({ url: stub.url, value: 'Authorization: Bearer s3cret' }), { ok: true })
    assert.equal(settings.webhookUrl, stub.url)
    assert.equal(secrets.authValue, 'Bearer s3cret')
    assert.deepEqual(await handlers['auth.status'](), { hasAuth: true, hasUrl: true, protection: 'os-keyring' })

    const event = (state) => ({ workspaceId: 'wt1', paneKey: 't:l', terminalId: 'term1', title: 'fix login', state, receivedAt: 1 })
    await emit(event('working'))
    await emit(event('done'))
    await emit(event('done'))
    assert.equal(stub.received.length, 1)
    assert.equal(stub.received[0].auth, 'Bearer s3cret')
    assert.equal(stub.received[0].body.text, 'shop/main: done - fix login')
    assert.equal(stub.received[0].body.repo, 'shop')
    assert.equal(stub.received[0].body.branch, 'main')

    // A new turn: working in between makes the next done fresh.
    await emit(event('working'))
    await emit(event('done'))
    assert.equal(stub.received.length, 2)

    await emit(event('waiting'))
    assert.equal(stub.received.length, 4)
    assert.equal(stub.received[3].body.state, 'waiting')

    const leaked = logs.filter((line) => line.includes('s3cret') || line.includes('t0ken'))
    assert.deepEqual(leaked, [])
    await assert.rejects(handlers['auth.set']({ url: 'ftp://x' }), /http\(s\)/)

    // A value pasted into the Settings field moves to secrets as soon as settings change.
    settings.authValue = 'Bearer n3w'
    await changeSettings()
    assert.equal(secrets.authValue, 'Bearer n3w')
    assert.equal(settings.authValue, '')
  } finally {
    stub.close()
    git.cleanup()
  }
})

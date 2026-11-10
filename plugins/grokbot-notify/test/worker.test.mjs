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

/** `terminals` maps a terminal id to its output lines; without it this Orca has no terminal.read. */
function mockOrca(workspaces = [], terminals = null, store = {}) {
  const settings = { states: 'done,waiting,blocked', remindMinutes: 30, webhookUrl: '', authValue: '' }
  const secrets = {}
  // Set fail.get / fail.set to make that secrets method throw, as Orca's store does without OS encryption.
  const fail = { get: false, set: false }
  const handlers = {}
  const logs = []
  const reads = []
  let listener = null
  let onSettings = null
  const orca = {
    log: (message) => logs.push(message),
    settings: { get: async (key) => (key === undefined ? { ...settings } : settings[key]), onDidChange: (fn) => (onSettings = fn) },
    storage: { get: async (key) => store[key] ?? null, set: async (key, value) => void (store[key] = JSON.parse(JSON.stringify(value))) },
    events: { on: (_event, fn) => (listener = fn) },
    panels: { handle: (name, fn) => (handlers[name] = fn) },
    host: {
      has: (method) => method === 'workspace.list' || method === 'secrets.protection' || (method === 'terminal.read' && Boolean(terminals)),
      call: async (method, params) => {
        if (method.startsWith('secrets.') && fail[method.slice('secrets.'.length)]) throw new Error('OS-backed encryption is unavailable')
        if (method === 'terminal.read') {
          reads.push(params.terminalId)
          if (!terminals[params.terminalId]) throw Object.assign(new Error('gone'), { code: 'not_found' })
          return { lines: terminals[params.terminalId], truncated: false }
        }
        if (method === 'secrets.get') return { value: secrets[params.key] ?? null }
        if (method === 'secrets.set') return void (secrets[params.key] = params.value)
        if (method === 'secrets.delete') return void delete secrets[params.key]
        if (method === 'settings.set') return void (settings[params.key] = params.value)
        if (method === 'secrets.protection') return { status: 'os-keyring' }
        if (method === 'workspace.list') return { workspaces }
        throw new Error(`unexpected ${method}`)
      },
    },
  }
  return { orca, settings, secrets, fail, handlers, logs, reads, emit: (event) => listener(event), changeSettings: () => onSettings() }
}

/** Claude Code's screen: the reply, then a footer whose counters change on their own. */
const screen = (reply, footer = 'ctx 22% · 782k left') => [...reply, '─'.repeat(40), '❯', '─'.repeat(40), `  ⏵⏵ bypass permissions on · ${footer}`]

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
    assert.deepEqual(await handlers['auth.status'](), { hasAuth: true, hasUrl: true, protection: 'os-keyring', routes: [], errors: [] })

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

test('routes: one line per bot, each gets only its workspaces with its own auth, repeat check and retry', async () => {
  const [pullo, nori, link] = [await startStub([503, 200]), await startStub([]), await startStub([])]
  const git = gitFixture()
  const { orca, settings, secrets, handlers, logs, emit } = mockOrca([
    { id: 'wt1', kind: 'worktree', name: 'main', branch: 'main', path: git.worktree },
    { id: 'wt2', kind: 'worktree', name: 'other', branch: 'other', path: git.root + '/elsewhere' },
  ])
  settings.webhookUrl = nori.url // ignored once routes has a line
  settings.routes = [
    '# bots',
    `풀로 | Fullops-Squad-plugin, SHOP | ${pullo.url} | Authorization: Bearer a1`,
    '',
    `노리 | jevpet | ${nori.url} | Bearer b2`,
    `링크 | wt/MAIN | ${link.url}`,
    'broken line with Bearer z9',
    `없음 | x | ftp://nope | Bearer z9`,
  ].join('\n')
  try {
    await activate(orca)
    assert.deepEqual(settings.routes.split('\n').slice(1, 4), [
      `풀로 | Fullops-Squad-plugin, SHOP | ${pullo.url} | (saved)`,
      '',
      `노리 | jevpet | ${nori.url} | (saved)`,
    ])
    // route_ + the first 16 hex of sha256('풀로'): a different key would orphan every saved Authorization.
    assert.equal(secrets.route_585a29126a02ed3f, 'Bearer a1')
    assert.ok(logs.includes('routes line 6 skipped: expected name | workspaces | URL | Authorization'))
    assert.ok(logs.includes('routes line 7 skipped: URL is not http(s)'))

    const done = (workspaceId) => ({ workspaceId, paneKey: 't:l', terminalId: 'term1', title: 'fix', state: 'done', receivedAt: 1 })
    await emit(done('wt1'))
    assert.equal(pullo.received.length, 2) // 503, then the retry
    assert.equal(pullo.received[1].auth, 'Bearer a1')
    assert.equal(pullo.received[1].body.route, '풀로')
    assert.equal(pullo.received[1].body.repo, 'shop')
    assert.equal(link.received.length, 1)
    assert.equal(link.received[0].auth, undefined)

    await emit(done('wt1')) // a repeat for both routes
    await emit(done('wt2')) // no route matches: no POST at all
    assert.deepEqual([pullo, nori, link].map((s) => s.received.length), [2, 0, 1])

    // Pasting a new line for 노리 replaces the old one.
    await handlers['auth.set']({ route: `노리 | jevpet,SHOP | ${nori.url} | Bearer b3` })
    assert.equal(settings.routes.split('\n').filter((line) => line.startsWith('노리')).length, 1)
    await emit({ ...done('wt1'), terminalId: 'term2' })
    assert.equal(nori.received.at(-1).auth, 'Bearer b3')

    settings.states = 'waiting' // test.send still sends its done alert
    const sent = await handlers['test.send']()
    assert.deepEqual(sent.routes.map((r) => r.route), ['풀로', '링크', '노리'])
    const status = await handlers['auth.status']()
    assert.deepEqual(status.routes.map((r) => [r.name, r.hasAuth]), [['풀로', true], ['링크', false], ['노리', true]])
    await assert.rejects(handlers['auth.set']({ route: 'only | two' }), /expected name/)

    assert.deepEqual(logs.filter((line) => /Bearer|t0ken/.test(line)), [])
  } finally {
    for (const stub of [pullo, nori, link]) stub.close()
    git.cleanup()
  }
})

test('issue #1: a terminal that keeps reporting waiting gets one alert, then one reminder after remindMinutes', async () => {
  const stub = await startStub([])
  const { orca, settings, emit } = mockOrca()
  settings.webhookUrl = stub.url
  const realNow = Date.now
  let now = realNow()
  Date.now = () => now
  try {
    await activate(orca)
    const waiting = { workspaceId: null, paneKey: 'p', terminalId: 'term_dd1', title: 'x', state: 'waiting', receivedAt: 1 }
    for (let i = 0; i < 7; i++, now += 45_000) await emit(waiting)
    assert.equal(stub.received.length, 1)
    now += 30 * 60_000
    await emit(waiting)
    await emit(waiting)
    assert.equal(stub.received.length, 2)
    await emit({ ...waiting, state: 'done' })
    assert.deepEqual(stub.received.map((r) => r.body.state), ['waiting', 'waiting', 'done'])
  } finally {
    Date.now = realNow
    stub.close()
  }
})

test('issue #3: an alert carries the masked tail, and the same state goes again only for new output', async () => {
  const stub = await startStub([])
  const terminals = { term1: screen(['\u001b[1m● 1.21.0을 릴리스할까요?\u001b[0m', '  Authorization: Bearer s3cret']) }
  const { orca, settings, logs, reads, emit } = mockOrca([], terminals)
  settings.webhookUrl = stub.url
  const event = (state) => ({ workspaceId: null, paneKey: 'p', terminalId: 'term1', title: 'x', state, receivedAt: 1 })
  try {
    await activate(orca)
    await emit(event('done'))
    assert.equal(stub.received.at(-1).body.tail, '● 1.21.0을 릴리스할까요?\n  Authorization: Bearer [REDACTED]')
    assert.equal(stub.received.at(-1).body.needsInput, true)
    assert.equal(stub.received.at(-1).body.text, 'Orca: done - x')

    // Only the footer's counters moved, or the same text re-wrapped in a resized terminal: not new output.
    terminals.term1 = screen(['● 1.21.0을 릴리스할까요?', '  Authorization: Bearer s3cret'], 'ctx 23% · 781k left')
    await emit(event('done'))
    terminals.term1 = screen(['● 1.21.0을', '릴리스할까요?', '  Authorization:', 'Bearer s3cret'])
    await emit(event('done'))
    assert.equal(stub.received.length, 1)

    terminals.term1 = screen(['● 2.0.0도 릴리스할까요?'])
    await emit(event('done'))
    assert.equal(stub.received.length, 2)
    assert.equal(stub.received.at(-1).body.tail, '● 2.0.0도 릴리스할까요?')

    // Issue #1 still holds, and the waiting Claude Code reports after done on the same screen adds nothing.
    for (let i = 0; i < 3; i++) await emit(event('waiting'))
    assert.equal(stub.received.length, 2)

    // A state not handed over reads nothing, and neither does `working`, whose output never stands still.
    settings.states = 'waiting'
    reads.length = 0
    await emit(event('blocked'))
    settings.states = 'done,waiting,working'
    await emit(event('working'))
    assert.deepEqual(reads, [])
    assert.equal(stub.received.at(-1).body.state, 'working')
    assert.equal(stub.received.at(-1).body.tail, null)
    assert.deepEqual(logs.filter((line) => line.includes('s3cret')), [])
  } finally {
    stub.close()
  }
})

test('a worker restart remembers what was sent; new output, a failure and a new terminal still go', async () => {
  const stub = await startStub([])
  const terminals = { term1: screen(['> 고쳐 주세요', '● 고쳤습니다. 병합할까요?']), term2: screen(['● 다른 작업 끝']) }
  const store = {}
  const event = (state, terminalId = 'term1') => ({ workspaceId: null, paneKey: 'p', terminalId, title: 'x', state, receivedAt: 1 })
  const start = async () => {
    const mock = mockOrca([], terminals, store)
    mock.settings.webhookUrl = stub.url
    delete mock.settings.remindMinutes // unset: Orca gives the manifest default, 0
    await activate(mock.orca)
    return mock
  }
  const realNow = Date.now
  let now = realNow()
  Date.now = () => now
  try {
    const first = await start()
    await first.emit(event('done'))
    assert.equal(stub.received.length, 1)
    const { eventId, read, question } = stub.received[0].body
    assert.match(eventId, /^[0-9a-f]{16}$/)
    assert.deepEqual([read, question], ['orca-helm read t:term1 --plain', '고쳤습니다. 병합할까요?'])

    // Orca stopped the idle worker; the next one holds the same screen in any state, and never reminds by default.
    const second = await start()
    now += 6 * 60_000
    await second.emit(event('waiting'))
    await second.emit(event('working'))
    await second.emit(event('done'))
    now += 60 * 60_000
    await second.emit(event('done'))
    assert.equal(stub.received.length, 1)

    await second.emit(event('done', 'term2'))
    terminals.term1 = screen(['> 고쳐 주세요', '● 고쳤습니다. 병합할까요?', '> 네', '● 병합했습니다.'])
    await second.emit(event('done'))
    await second.emit(event('blocked'))
    assert.deepEqual(stub.received.slice(1).map(({ body }) => `${body.terminalId}:${body.state}`), ['term2:done', 'term1:done', 'term1:blocked'])
    assert.notEqual(stub.received[2].body.eventId, eventId) // another output, another event

    // Counts carry over the restart too: first worker's done, then term2's done and the blocked.
    const day = Object.values(await second.handlers['alerts.counts']())[0]['']
    assert.deepEqual(day, { 'sent.new': 3, 'held.flap': 2, 'held.same': 1, 'sent.changed': 1 })
  } finally {
    Date.now = realNow
    stub.close()
  }
})

test('a done showing only Claude Code start screen is not sent', async () => {
  const stub = await startStub([])
  const fresh = [' ▐▛███▛█   Claude Code v2.1.319', '▝▜██████▀  Opus 5.5 · Claude Ultra', ' ▝▝   ▝▝   D:\\workspace\\x']
  const terminals = { term1: screen(fresh) }
  const { orca, settings, handlers, emit } = mockOrca([], terminals)
  settings.webhookUrl = stub.url
  const done = { workspaceId: null, paneKey: 'p', terminalId: 'term1', title: 'Claude Code', state: 'done', receivedAt: 1 }
  try {
    await activate(orca)
    await emit(done)
    assert.equal(stub.received.length, 0)
    terminals.term1 = screen([...fresh, '> 상태 알려 줘', '● 테스트 3건 실패입니다.'])
    await emit(done)
    assert.equal(stub.received.length, 1)
    assert.equal(stub.received[0].body.result, '테스트 3건 실패입니다.')
    assert.equal(Object.values(await handlers['alerts.counts']())[0]['']['held.start-screen'], 1)
  } finally {
    stub.close()
  }
})

test('issue #3: a terminal that cannot be read still gets its alert, once, without a tail', async () => {
  const stub = await startStub([])
  const { orca, settings, logs, emit } = mockOrca([], {})
  settings.webhookUrl = stub.url
  const done = { workspaceId: null, paneKey: 'p', terminalId: 'closed', title: 'x', state: 'done', receivedAt: 1 }
  try {
    await activate(orca)
    await emit(done)
    await emit(done)
    assert.equal(stub.received.length, 1)
    assert.deepEqual([stub.received[0].body.tail, stub.received[0].body.needsInput], [null, false])
    assert.ok(logs.includes('could not read terminal output: not_found'))
  } finally {
    stub.close()
  }
})

test('issue #2: an open FullOps decision of a bot task goes to its routes once, with what it takes to answer', async () => {
  const stub = await startStub([503, 503])
  const git = gitFixture()
  fs.mkdirSync(path.join(git.worktree, '.fullops-squad'))
  fs.writeFileSync(path.join(git.worktree, '.fullops-squad', 'fullops.json'), '{}')
  // The linked worktree's records live in the main repo's .git, the Git common directory.
  const records = path.join(git.root, 'shop', '.git', 'fullops-decisions')
  fs.mkdirSync(records)
  const write = (item) => fs.writeFileSync(path.join(records, `${item.id}.json`), JSON.stringify(item))
  const sha = 'c'.repeat(40)
  const d001 = { version: 1, id: 'D001', status: 'open', key: 'login', question: '병합할까요?', options: ['진행', '보류'], blocks: 'login merge', origin: 'bot', sha, risks: ['auth'] }
  write(d001)
  write({ version: 1, id: 'D002', status: 'open', question: 'asked in the Orca chat', origin: 'user' })
  write({ version: 2, id: 'D003', status: 'open', question: 'a newer format', origin: 'bot' })
  const { orca, settings, logs, emit } = mockOrca([{ id: 'wt1', kind: 'worktree', name: 'main', branch: 'main', path: git.worktree }])
  settings.routes = `풀로 | shop | ${stub.url} | Bearer a1`
  settings.states = 'done' // the terminal alert for `working` stays out of this test
  try {
    await activate(orca)
    const working = { workspaceId: 'wt1', paneKey: 'p', terminalId: 't1', title: 'x', state: 'working', receivedAt: 1 }
    await emit(working) // 503 and its retry: not sent yet
    await emit(working) // tried again
    await emit(working) // already delivered
    assert.equal(stub.received.length, 3)
    const { body, auth } = stub.received[2]
    assert.equal(auth, 'Bearer a1')
    assert.equal(body.event, 'fullops.decision')
    assert.equal(body.text, 'shop/D001: decision waiting - 병합할까요? [진행 / 보류] (risks: auth; blocks: login merge; sha: cccccccccccc)')
    assert.equal(body.reply, `orca-helm decide shop/D001 --sha ${sha} --answer <answer> --by <who>`)
    assert.deepEqual([body.decision, body.repo, body.route], [d001, 'shop', '풀로'])
    assert.ok(logs.includes('FullOps decision D003 is format version 2; update grokbot-notify to send it'))

    // Once answered it is forgotten; a decision opened later goes out.
    write({ ...d001, status: 'answered' })
    write({ version: 1, id: 'D004', status: 'open', question: '다음 단계?', origin: 'bot' })
    await emit(working)
    assert.deepEqual(stub.received.slice(3).map((r) => r.body.decision.id), ['D004'])
    assert.deepEqual(logs.filter((line) => /Bearer|t0ken/.test(line)), [])
  } finally {
    stub.close()
    git.cleanup()
  }
})

test('a FullOps alert carries the same report terminal alert: one POST, unless the FullOps one fails', async () => {
  const stub = await startStub([503, 503])
  const git = gitFixture()
  fs.mkdirSync(path.join(git.worktree, '.fullops-squad'))
  fs.writeFileSync(path.join(git.worktree, '.fullops-squad', 'fullops.json'), '{}')
  const records = path.join(git.root, 'shop', '.git', 'fullops-decisions')
  fs.mkdirSync(records)
  const write = (item) => fs.writeFileSync(path.join(records, `${item.id}.json`), JSON.stringify(item))
  write({ version: 1, id: 'D001', status: 'open', question: '병합할까요?', options: ['진행', '보류'], origin: 'bot' })
  const terminals = { t1: screen(['● D001 결정을 기다립니다. 병합할까요?']) }
  const { orca, settings, handlers, emit } = mockOrca([{ id: 'wt1', kind: 'worktree', name: 'main', branch: 'main', path: git.worktree }], terminals)
  settings.routes = `풀로 | shop | ${stub.url}`
  const done = { workspaceId: 'wt1', paneKey: 'p', terminalId: 't1', title: 'x', state: 'done', receivedAt: 1 }
  const sent = () => stub.received.map(({ body }) => `${body.event}${body.agentStatus ? '+agentStatus' : ''}`)
  try {
    await activate(orca)
    // The FullOps POST carrying it fails (and its retry): the terminal alert goes on its own, the decision at the next report.
    await emit(done)
    await emit(done)
    assert.deepEqual(sent(), ['fullops.decision+agentStatus', 'fullops.decision+agentStatus', 'agent.status.changed', 'fullops.decision'])

    write({ version: 1, id: 'D002', status: 'open', question: '배포할까요?', origin: 'bot' })
    terminals.t1 = screen(['● D002 결정을 기다립니다. 배포할까요?'])
    await emit(done)
    assert.deepEqual(sent().slice(4), ['fullops.decision+agentStatus'])
    const { body } = stub.received[4]
    assert.deepEqual([body.decisionId, body.agentStatus.event, body.agentStatus.question], ['shop/D002', 'agent.status.changed', 'D002 결정을 기다립니다. 배포할까요?'])
    assert.match(body.eventId, /^[0-9a-f]{16}$/)

    const day = Object.values(await handlers['alerts.counts']())[0]['풀로']
    assert.deepEqual(day, { 'sent.new': 1, 'fullops.post.retried': 1, 'fullops.post.failed': 1, 'held.same': 1, 'fullops.sent': 2, 'sent.changed': 1, merged: 1 })
  } finally {
    stub.close()
    git.cleanup()
  }
})

// A stand-in for `orca orchestration`: node runs ./orchestration, which answers from script.json.
const FAKE_ORCA = `const fs = require('fs')
const script = JSON.parse(fs.readFileSync('script.json', 'utf8'))
const answer = (result) => process.stdout.write(JSON.stringify({ ok: true, result }))
if (script.down) {
  process.stdout.write(JSON.stringify({ ok: false, error: { code: 'unavailable', message: 'orca is down' } }))
  process.exitCode = 1
} else if (process.argv[2] === 'inbox') answer({ messages: script.messages })
else answer({ workspace: script.workspaces[process.argv[process.argv.indexOf('--dispatch') + 1]] })
`

test('issue #2: judgments, holds, failures and escalations reach a person once, even across a worker restart', async (t) => {
  const stub = await startStub([])
  const git = gitFixture()
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'grokbot-notify-orca-'))
  fs.writeFileSync(path.join(fake, 'package.json'), '{"type":"commonjs"}')
  fs.writeFileSync(path.join(fake, 'orchestration'), FAKE_ORCA)
  const script = (value) => fs.writeFileSync(path.join(fake, 'script.json'), JSON.stringify(value))
  const cwd = process.cwd()
  const bin = process.env.ORCA_HELM_BIN
  process.chdir(fake)
  process.env.ORCA_HELM_BIN = process.execPath
  t.after(() => {
    process.chdir(cwd)
    if (bin === undefined) delete process.env.ORCA_HELM_BIN
    else process.env.ORCA_HELM_BIN = bin
    stub.close()
    git.cleanup()
    fs.rmSync(fake, { recursive: true, force: true })
  })

  fs.mkdirSync(path.join(git.worktree, '.fullops-squad'))
  fs.writeFileSync(path.join(git.worktree, '.fullops-squad', 'fullops.json'), '{}')
  const common = path.join(git.root, 'shop', '.git')
  const write = (folder, name, item) => {
    fs.mkdirSync(path.join(common, folder), { recursive: true })
    fs.writeFileSync(path.join(common, folder, `${name}.json`), JSON.stringify(item))
  }
  const sha = 'c'.repeat(40)
  const leak = 'Authorization: Bearer s3cret-token'
  const judgment = { version: 1, kind: 'autonomy_judgment', grade: 'ask', blocked: false, blockers: [], reasons: [`auth 경로 ${leak}`], key: 'login', origin: 'bot', head: sha }
  write('fullops-autonomy', 'login-ask', judgment)
  write('fullops-autonomy', 'chat-ask', { ...judgment, key: 'chat', origin: 'user' })
  write('fullops-autonomy', 'docs-auto', { ...judgment, key: 'docs', grade: 'auto' })
  write('fullops-autonomy', 'lint-delay', { ...judgment, key: 'lint', grade: 'delay', blocked: true, blockers: ['lint ERROR 1건'] })
  write('fullops-autonomy', 'next-v2', { ...judgment, key: 'next', version: 2 })
  // The decision on this commit asks the person, so its `ask` judgment adds nothing.
  write('fullops-autonomy', 'pay-ask', { ...judgment, key: 'pay', head: 'd'.repeat(40) })
  write('fullops-decisions', 'D001', { version: 1, id: 'D001', status: 'open', key: 'pay', question: `병합? ${leak}`, origin: 'bot', sha: 'd'.repeat(40) })
  write('fullops-decisions', 'D002', { version: 1, id: 'D002', status: 'open', question: 'too late', origin: 'bot', expires_at: '2026-01-01T00:00:00+00:00' })
  write('fullops-integration', 'aaa', { message: 'msg_0', key: 'login', sha, hold: { reason: 'CI 실패', owner: 'dev', resume: 'CI 수정 후' } })
  write('fullops-integration', 'bbb', { message: 'msg_9', key: 'old', sha })
  const old = path.join(common, 'fullops-integration', 'old.json')
  fs.writeFileSync(old, JSON.stringify({ message: 'msg_8', key: 'old', hold: { reason: 'long ago' } }))
  fs.utimesSync(old, new Date(0), new Date(0))

  const at = new Date().toISOString()
  const message = (id, type, dispatchId, extra = {}) => ({ id, type, subject: `${id} subject`, body: `막힘 ${leak}`, created_at: at, payload: JSON.stringify({ dispatchId, ...extra }) })
  const inbox = {
    messages: [
      message('msg_1', 'escalation', 'ctx_shop'),
      message('msg_2', 'worker_done', 'ctx_shop', { outcome: 'failed' }),
      message('msg_3', 'worker_done', 'ctx_shop', { outcome: 'succeeded' }),
      message('msg_4', 'question', 'ctx_shop'),
      message('msg_5', 'escalation', 'ctx_other'),
      { ...message('msg_6', 'escalation', 'ctx_shop'), created_at: '2026-01-01T00:00:00Z' },
    ],
    workspaces: { ctx_shop: 'r1::C:/wt/shop', ctx_other: 'r2::C:/wt/other' },
  }
  script(inbox)

  const store = {}
  const workspaceId = `r1::${git.worktree}`
  const start = async () => {
    const mock = mockOrca([{ id: workspaceId, kind: 'worktree', name: 'main', branch: 'main', path: git.worktree }], null, store)
    mock.settings.routes = `풀로 | shop | ${stub.url} | Bearer a1`
    mock.settings.states = 'blocked' // no terminal alerts in this test
    await activate(mock.orca)
    return mock
  }
  const settled = { workspaceId, paneKey: 'p', terminalId: 't1', title: 'x', state: 'done', receivedAt: 1 }
  const sent = () => stub.received.map(({ body }) => body.event + (body.key ? `:${body.key}` : '') + (body.messageId ? `:${body.messageId}` : '') + (body.decision ? `:${body.decision.id}` : ''))

  const first = await start()
  await first.emit(settled)
  assert.deepEqual(sent().sort(), [
    'fullops.decision:D001',
    'fullops.escalation:msg_1',
    'fullops.failed:msg_2',
    'fullops.hold:login',
    'fullops.judgment:lint',
    'fullops.judgment:login',
  ])
  const bodies = Object.fromEntries(stub.received.map(({ body }) => [body.event, body]))
  assert.equal(bodies['fullops.hold'].text, 'shop: login on hold - CI 실패 (owner: dev; resume: CI 수정 후)')
  assert.equal(bodies['fullops.hold'].sha, sha)
  assert.equal(bodies['fullops.decision'].decision.sha, 'd'.repeat(40))
  assert.equal(bodies['fullops.escalation'].body, '막힘 Authorization: Bearer [REDACTED]')
  assert.doesNotMatch(JSON.stringify(stub.received.map((r) => r.body)), /s3cret-token|t0ken|Bearer a1/)
  assert.ok(first.logs.includes('FullOps judgment next-v2 is format version 2; update grokbot-notify to send it'))

  // Orca stops an idle worker; the next one remembers. A `working` report does not read messages or forget them.
  const count = stub.received.length
  const second = await start()
  await second.emit(settled)
  await second.emit({ ...settled, state: 'working' })
  await second.emit(settled)
  assert.equal(stub.received.length, count)

  // Orca is unreachable: nothing to read, and what was sent is not forgotten.
  script({ down: true })
  await second.emit(settled)
  assert.ok(second.logs.includes('could not read Orca messages: orca is down'))
  script(inbox)
  await second.emit(settled)
  assert.equal(stub.received.length, count)

  // A hold that was resumed and set again is news; so is an auto judgment once asked for.
  write('fullops-integration', 'aaa', { message: 'msg_0', key: 'login', sha })
  await second.emit(settled)
  write('fullops-integration', 'aaa', { message: 'msg_0', key: 'login', sha, hold: { reason: 'CI 실패', owner: 'dev', resume: 'CI 수정 후' } })
  second.settings.fullopsAuto = true
  await second.emit(settled)
  assert.deepEqual(sent().slice(count).sort(), ['fullops.hold:login', 'fullops.judgment:docs'])
})

test('a failed delivery logs no secret and is tried again on the next report of that state', async () => {
  const { orca, settings, logs, emit } = mockOrca()
  // fetch refuses a URL with credentials, and its own message quotes them.
  settings.webhookUrl = 'http://bot:s3cret@127.0.0.1:9/hook'
  await activate(orca)
  const done = { workspaceId: null, paneKey: 'p', terminalId: 't1', title: 'x', state: 'done', receivedAt: 1 }
  await emit(done)
  const failed = () => logs.filter((line) => line.includes('failed: TypeError')).length
  assert.equal(failed(), 2) // the attempt and its retry
  await emit(done)
  assert.equal(failed(), 4)
  assert.deepEqual(logs.filter((line) => line.includes('s3cret')), [])
})

test('an Authorization that secrets cannot store or read is kept and sent, never dropped', async () => {
  const stub = await startStub([])
  const { orca, settings, secrets, fail, handlers, emit, changeSettings } = mockOrca()
  settings.webhookUrl = stub.url
  settings.authValue = 'Bearer single'
  fail.set = true
  try {
    // Nothing can be stored: pasted values stay where they are and are sent from there.
    await activate(orca)
    assert.equal(settings.authValue, 'Bearer single')
    await emit({ workspaceId: null, paneKey: 'p', terminalId: 't1', title: 'x', state: 'done', receivedAt: 1 })
    assert.equal(stub.received.at(-1).auth, 'Bearer single')
    const raw = `bot | | ${stub.url} | Bearer line`
    settings.routes = raw
    await changeSettings()
    assert.equal(settings.routes, raw)
    // Editing that bot with the field left empty fails instead of writing its line without the value.
    await assert.rejects(handlers['routes.save']({ previousName: 'bot', name: 'bot', url: stub.url, workspaces: ['shop'], auth: '' }))
    assert.equal(settings.routes, raw)

    // The store cannot be read: neither a rename nor an edit may drop (saved) or delete the stored value.
    fail.set = false
    settings.routes = ''
    await handlers['routes.save']({ name: 'A', url: stub.url, workspaces: [], auth: 'Bearer a' })
    fail.get = true
    await assert.rejects(handlers['routes.save']({ previousName: 'A', name: 'B', url: stub.url, workspaces: [], auth: '' }))
    await assert.rejects(handlers['routes.save']({ previousName: 'A', name: 'A', url: stub.url, workspaces: ['x'], auth: '' }))
    assert.ok(Object.values(secrets).includes('Bearer a'))
    assert.equal(settings.routes, `A |  | ${stub.url} | (saved)`)
  } finally {
    stub.close()
  }
})

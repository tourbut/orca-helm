import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseCommandLine } from '../lib/core.mjs'
import { main } from '../lib/cli.mjs'

// `orca worktree ps` and `orca terminal list` answer in turn from script.ps / script.terminals, one entry per call.
// Any other `<file> <verb>` (`terminal send`, `repo list`, ...) answers script['<file> <verb>']: { result }, returned
// with the argv it got, or a raw { body, code }. An unscripted `terminal send` just echoes its argv.
const FAKE = `const fs = require('fs')
const file = require('path').basename(__filename)
const command = file + ' ' + process.argv[2]
const script = JSON.parse(fs.readFileSync('script.json', 'utf8'))
const answer = script[command] ?? (command === 'terminal send' ? { result: {} } : null)
if (answer) {
  process.stdout.write(JSON.stringify(answer.body ?? { ok: true, result: { ...answer.result, argv: process.argv.slice(3) } }))
  process.exitCode = answer.code ?? 0
  return
}
const key = file === 'worktree' ? 'ps' : 'terminals'
const seq = script[key]
const n = fs.existsSync(key + '.n') ? Number(fs.readFileSync(key + '.n', 'utf8')) : 0
fs.writeFileSync(key + '.n', String(n + 1))
process.stdout.write(JSON.stringify({ ok: true, result: seq[Math.min(n, seq.length - 1)] }))
`

/** Run the CLI against a fake orca (node runs ./worktree, ./terminal or ./repo in a temp dir holding `files`, with `env`). */
async function runWithFakeOrca(script, argv, files = {}, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-helm-fake-'))
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs"}')
  for (const name of ['worktree', 'terminal', 'repo']) fs.writeFileSync(path.join(dir, name), FAKE)
  fs.writeFileSync(path.join(dir, 'script.json'), JSON.stringify(script))
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    fs.writeFileSync(path.join(dir, name), content)
  }
  const out = path.join(dir, 'out.json')
  const vars = { ORCA_HELM_BIN: process.execPath, ...env }
  const prev = { cwd: process.cwd(), env: Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]])) }
  process.chdir(dir)
  Object.assign(process.env, vars)
  try {
    const { code, stderr } = await captureStderr(() => main(parseCommandLine([...argv, '--out', out])))
    const read = (name) => (fs.existsSync(name) ? fs.readFileSync(name, 'utf8') : '')
    // calls.txt: what a fake tool (decision.py) was asked to do.
    return { code, stderr, stdout: read(out), calls: read('calls.txt') }
  } finally {
    process.chdir(prev.cwd)
    for (const [key, value] of Object.entries(prev.env)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

async function captureStderr(fn) {
  const write = process.stderr.write
  let stderr = ''
  process.stderr.write = (chunk) => ((stderr += chunk), true)
  try {
    return { code: await fn(), stderr }
  } finally {
    process.stderr.write = write
  }
}

const worktree = (id, path, state, since = Date.now()) => ({
  worktreeId: id,
  repoId: 'r1',
  repo: 'shop',
  path,
  displayName: 'app',
  agents: state ? [{ paneKey: `${id}:leaf`, state, agentType: 'claude', stateStartedAt: since }] : [],
})
const terminal = (handle, id) => ({ handle, worktreeId: id, tabId: id, leafId: 'leaf', title: 'agent' })
/** One `app` worktree with terminal h1. */
const one = (state, since) => ({ ps: [{ worktrees: [worktree('w1', '/a/app', state, since)] }], terminals: [{ terminals: [terminal('h1', 'w1')] }] })

test('an extra positional argument exits 1 with the usage line', async () => {
  for (const argv of [['status', 'shop', 'main'], ['read', 'x', '--', 'y'], ['help', 'status']]) {
    const { code, stderr } = await captureStderr(() => main(parseCommandLine(argv)))
    assert.equal(code, 1, argv.join(' '))
    assert.match(stderr, /unexpected argument "(main|y|status)"/)
    assert.match(stderr, new RegExp(`usage: orca-helm ${argv[0]} `))
  }
})

test('wait polls the handle it resolved first, and fails when that terminal is gone', async () => {
  // A second "app" worktree appears mid-wait; matching the query again would be ambiguous (exit 3).
  const settled = await runWithFakeOrca(
    {
      ps: [
        { worktrees: [worktree('w1', '/a/app', 'working')] },
        { worktrees: [worktree('w1', '/a/app', 'working'), worktree('w2', '/b/app', 'working')] },
        { worktrees: [worktree('w1', '/a/app', 'done'), worktree('w2', '/b/app', 'working')] },
      ],
      terminals: [{ terminals: [terminal('h1', 'w1')] }, { terminals: [terminal('h1', 'w1'), terminal('h2', 'w2')] }],
    },
    ['wait', 'app', '--interval', '0', '--timeout', '20', '--json'],
  )
  assert.equal(settled.code, 0, settled.stderr)
  assert.equal(JSON.parse(settled.stdout).row.handle, 'h1')

  const gone = await runWithFakeOrca(
    { ps: [{ worktrees: [worktree('w1', '/a/app', 'working')] }], terminals: [{ terminals: [terminal('h1', 'w1')] }, { terminals: [] }] },
    ['wait', 'app', '--interval', '0', '--timeout', '20'],
  )
  assert.equal(gone.code, 1)
  assert.match(gone.stderr, /terminal t:h1 \(shop\/app\) is gone/)
})

test('wait exits 2 on a timeout; a fresh done ends it at once, a stale one does not', async () => {
  assert.equal((await runWithFakeOrca(one('done'), ['wait', 'app', '--timeout', '0'])).code, 0)
  const stale = await runWithFakeOrca(one('done', Date.now() - 120_000), ['wait', 'app', '--timeout', '0', '--json'])
  assert.equal(stale.code, 2, stale.stderr)
  assert.equal(JSON.parse(stale.stdout).timedOut, true)
  // Orca 1.4.247 answers a timed-out `terminal wait` with exit 1 and an error body, no wait result.
  const timeout = { 'terminal wait': { body: { ok: false, error: { code: 'timeout', message: 'timeout' } }, code: 1 } }
  const exit = await runWithFakeOrca({ ...one('working'), ...timeout }, ['wait', 'app', '--for', 'exit', '--timeout', '1'])
  assert.equal(exit.code, 2, exit.stderr)
  assert.match(exit.stdout, /^timeout shop\/app t:h1 exit/)
})

test('send: exit 3 when ambiguous, one --text= token, a cleaned --file, no non-UTF-8 file, a refusal with its reason', async () => {
  const two = {
    ps: [{ worktrees: [worktree('w1', '/a/app', 'working'), worktree('w2', '/b/app', 'working')] }],
    terminals: [{ terminals: [terminal('h1', 'w1'), terminal('h2', 'w2')] }],
  }
  const ambiguous = await runWithFakeOrca(two, ['send', 'app', '--text', 'x', '--json'])
  assert.equal(ambiguous.code, 3, ambiguous.stderr)
  assert.equal(JSON.parse(ambiguous.stdout).ambiguous.length, 2)

  // Orca would read a separate `--- plan` value as a flag. The BOM, CRLF and trailing newlines go.
  const sent = await runWithFakeOrca(one('working'), ['send', 'app', '--file', 'p.txt', '--json'], { 'p.txt': '﻿--- plan\r\ntwo\r\n\r\n' })
  assert.equal(sent.code, 0, sent.stderr)
  assert.ok(JSON.parse(sent.stdout).argv.includes('--text=--- plan\ntwo'))

  // Windows PowerShell 5.1 writes ANSI (Set-Content) or UTF-16 (Out-File, >).
  const ansi = await runWithFakeOrca(one('working'), ['send', 'app', '--file', 'k.txt'], { 'k.txt': Buffer.from([0xbe, 0xc8, 0xb3, 0xe7]) })
  assert.equal(ansi.code, 1)
  assert.match(ansi.stderr, /cannot read k\.txt/)
  const utf16 = await runWithFakeOrca(one('working'), ['send', 'app', '--file', 'u.txt'], { 'u.txt': Buffer.from('hi', 'utf16le') })
  assert.equal(utf16.code, 1)
  assert.match(utf16.stderr, /u\.txt is not UTF-8 text/)

  const refuse = { 'terminal send': { body: { ok: true, result: { send: { accepted: false, refusedReason: 'busy' } } }, code: 1 } }
  const refused = await runWithFakeOrca({ ...one('working'), ...refuse }, ['send', 'app', '--text', 'hi'])
  assert.equal(refused.code, 1)
  assert.match(refused.stderr, /input refused by t:h1: busy/)
})

test('start needs --agent, passes one --prompt= token, and prints the handle of a terminal agent', async () => {
  const noAgent = await captureStderr(() => main(parseCommandLine(['start', 'shop', '--name', 'fix-x', '--text', 'go'])))
  assert.equal(noAgent.code, 1)
  assert.match(noAgent.stderr, /start requires --agent/)

  const argv = ['start', 'shop', '--name', 'fix-x', '--agent', 'claude', '--text=--- go']
  const created = (result) => ({
    'repo list': { result: { repos: [{ id: 'r1', displayName: 'shop', path: '/src/shop' }] } },
    'worktree create': { result: { worktree: { id: 'w9', displayName: 'fix-x' }, ...result } },
  })
  // agent.launch hosts (Orca 1.4.247) report launch.outcome; older ones agentTerminalHandle; a chat has no terminal.
  const launched = await runWithFakeOrca(created({ launch: { outcome: { kind: 'terminal', handle: 'term_new' } } }), argv)
  assert.equal(launched.stdout, 'created fix-x id:w9 repo:r1\nt:term_new\n', launched.stderr)
  assert.match((await runWithFakeOrca(created({ agentTerminalHandle: 'term_old' }), argv)).stdout, /\nt:term_old\n$/)
  const chat = await runWithFakeOrca(created({ launch: { outcome: { kind: 'structured', handle: 'chat_1' } } }), argv)
  assert.equal(chat.stdout, 'created fix-x id:w9 repo:r1\n')
  const json = await runWithFakeOrca(created({}), [...argv, '--json'])
  assert.ok(JSON.parse(json.stdout).argv.includes('--prompt=--- go'))
})

test('ORCA_HELM_STDOUT_FILE (set by orca-helm.ps1) gets stdout with no "wrote" line, and --help exits 0', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-helm-shim-'))
  const prev = process.env.ORCA_HELM_STDOUT_FILE
  process.env.ORCA_HELM_STDOUT_FILE = path.join(dir, 'out.txt')
  try {
    assert.deepEqual(await captureStderr(() => main(parseCommandLine(['--version']))), { code: 0, stderr: '' })
    assert.match(fs.readFileSync(process.env.ORCA_HELM_STDOUT_FILE, 'utf8'), /^\d+\.\d+\.\d+\n$/)
    assert.equal((await captureStderr(() => main(parseCommandLine(['--help'])))).code, 0)
  } finally {
    if (prev === undefined) delete process.env.ORCA_HELM_STDOUT_FILE
    else process.env.ORCA_HELM_STDOUT_FILE = prev
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// A stand-in for FullOps decision.py (node runs it; the source holds '--via' like FullOps 1.16.0+). Records come from
// decisions.json keyed by --repo; answer refuses another SHA the way FullOps does (argparse exit 2).
const DECISION_PY = `// FullOps 1.16.0+ answers take '--via'
const fs = require('fs')
const [action, ...rest] = process.argv.slice(2)
const opt = Object.fromEntries(rest.map((arg) => arg.replace(/^--/, '').split(/=(.*)/s).slice(0, 2)))
const items = JSON.parse(fs.readFileSync('decisions.json', 'utf8'))[opt.repo] ?? []
fs.appendFileSync('calls.txt', action + '\\n')
const refuse = (reason) => { process.stderr.write('usage: decision.py\\ndecision.py: error: ' + reason + '\\n'); process.exitCode = 2 }
const item = items.find((i) => i.id === opt.id)
if (action === 'list') process.stdout.write(JSON.stringify({ decisions: rest.includes('--all') ? items : items.filter((i) => i.status === 'open') }))
else if (!item) refuse('결정 ' + opt.id + '이 없습니다')
else if (item.status !== 'open') process.stdout.write(JSON.stringify({ ...item, already: true }))
else if (item.sha && opt.sha !== item.sha) refuse('결정 ' + item.id + '은 ' + item.sha.slice(0, 12) + '에 묶여 있습니다')
else process.stdout.write(JSON.stringify({ ...item, status: 'answered', answer: opt.answer, decided_by: opt.by, via: opt.via }))
`

test('issue #2: decisions and decide go through FullOps decision.py; no FullOps or another format exits 4', async () => {
  const sha = 'a'.repeat(40)
  const book = {
    shop: [
      { version: 1, id: 'D001', status: 'open', key: 'login', question: '병합할까요?', options: ['진행', '보류'], sha, risks: ['auth'], origin: 'bot' },
      { version: 1, id: 'D002', status: 'answered', key: 'old', question: 'x', answer: '진행', decided_by: 'me' },
    ],
    cafe: [{ id: 'D001', status: 'open', question: '배포할까요?', origin: 'user' }],
  }
  const repos = [{ id: 'r1', displayName: 'shop', path: 'shop' }, { id: 'r2', displayName: 'cafe', path: 'cafe' }, { id: 'r3', displayName: 'plain', path: 'plain' }]
  const files = {
    'shop/.fullops-squad/fullops.json': '{}',
    'cafe/.fullops-squad/fullops.json': '{}',
    'fullops/scripts/decision.py': DECISION_PY,
    'decisions.json': JSON.stringify(book),
  }
  const run = (argv, extra = {}) =>
    runWithFakeOrca({ 'repo list': { result: { repos } } }, argv, { ...files, ...extra.files }, { ORCA_HELM_FULLOPS: 'fullops', ORCA_HELM_PYTHON: process.execPath, ...extra.env })

  const listed = await run(['decisions', '--json'])
  assert.equal(listed.code, 0, listed.stderr)
  assert.deepEqual(JSON.parse(listed.stdout).decisions.map((d) => `${d.repo}/${d.id}`), ['shop/D001', 'cafe/D001'])
  assert.equal((await run(['decisions', 'shop'])).stdout, `shop/D001  open  login  "병합할까요?"  [진행 / 보류]  sha:${sha}  risks:auth  origin:bot\n`)

  // Decision IDs are numbered per repo, so a bare D001 names two here.
  assert.equal((await run(['decide', 'D001', '--answer', '진행', '--by', 'shin'])).code, 3)
  const moved = await run(['decide', 'shop/D001', '--answer', '진행', '--by', 'shin', '--sha', 'b'.repeat(40)])
  assert.equal(moved.code, 1)
  assert.match(moved.stderr, /^orca-helm: 결정 D001은 aaaaaaaaaaaa에 묶여 있습니다\n/) // FullOps's reason, not its usage line
  const answered = await run(['decide', 'shop/D001', '--answer', '진행', '--by', 'shin', '--sha', sha, '--json'])
  assert.equal(answered.code, 0, answered.stderr)
  assert.deepEqual(JSON.parse(answered.stdout), { ...book.shop[0], repo: 'shop', status: 'answered', answer: '진행', decided_by: 'shin', via: 'bot' })
  assert.equal((await run(['decide', 'shop/D002', '--answer', '보류', '--by', 'shin'])).stdout, 'already answered shop/D002: 진행\n')

  const newer = { files: { 'decisions.json': JSON.stringify({ shop: [{ version: 2, id: 'D009', status: 'open', question: 'q' }] }) } }
  const v2 = await run(['decisions'], newer)
  assert.equal(v2.code, 4)
  assert.match(v2.stderr, /D009 is format version 2/)
  // An answer to a record in another format is refused before decision.py writes anything.
  const v2answer = await run(['decide', 'shop/D009', '--answer', 'x', '--by', 'shin'], newer)
  assert.equal(v2answer.code, 4)
  assert.equal(v2answer.calls, 'list\n')
  const old = await run(['decisions'], { files: { 'fullops/scripts/decision.py': '// FullOps 1.15' } })
  assert.equal(old.code, 4)
  assert.match(old.stderr, /older than FullOps 1\.16\.0/)
  const missing = await run(['decide', 'shop/D001', '--answer', 'x', '--by', 'shin'], { env: { ORCA_HELM_FULLOPS: 'nowhere' } })
  assert.equal(missing.code, 4)
  assert.match(missing.stderr, /decision\.py not found/)
})

test('issue #2: in a FullOps repo, work for a worker and start go to the coordinator unless --bypass-fullops', async () => {
  // As in the user's repos: the coordinator runs in the `fullops/coor` role worktree, not the main one.
  const config = JSON.stringify({ roles: { coor: 'fullops/coor', dev: 'fullops/dev' } })
  const agents = '## 라우팅 기준\n\n- coordinator 역할: `coor`\n'
  const files = {}
  for (const dir of ['shop', 'wt/coor', 'wt/dev']) {
    files[`${dir}/.fullops-squad/fullops.json`] = config
    files[`${dir}/.fullops-squad/orca-agents.md`] = agents
  }
  const at = (id, dir, branch, isMainWorktree) => ({ ...worktree(id, dir, 'waiting'), branch: `refs/heads/${branch}`, isMainWorktree, displayName: id })
  const script = {
    ps: [{ worktrees: [at('main', 'shop', 'main', true), at('coor', 'wt/coor', 'fullops/coor', false), at('dev', 'wt/dev', 'fullops/dev', false)] }],
    terminals: [{ terminals: [terminal('hm', 'main'), terminal('hc', 'coor'), terminal('hw', 'dev')] }],
    'repo list': { result: { repos: [{ id: 'r1', displayName: 'shop', path: 'shop' }] } },
    'worktree create': { result: { worktree: { id: 'w9', displayName: 'x' } } },
  }
  const run = (...argv) => runWithFakeOrca(script, argv, files)
  const work = '--text=implement the login fix'

  const refused = await run('send', 't:hw', work)
  assert.equal(refused.code, 1)
  assert.match(refused.stderr, /t:hw is a FullOps worker \(shop\/dev\)/)
  assert.equal((await run('send', 't:hw', '--text', 'y')).code, 0) // a prompt answer still reaches a worker
  assert.equal((await run('send', 't:hw', work, '--bypass-fullops')).code, 0)
  assert.equal((await run('send', 't:hc', work)).code, 0, 'the coordinator in its role worktree takes work')
  assert.equal((await run('send', 't:hm', work)).code, 0, 'a branch with no role is not a worker')
  const start = await run('start', 'shop', '--name', 'x', '--agent', 'claude', '--text', 'go')
  assert.equal(start.code, 1)
  assert.match(start.stderr, /shop is a FullOps repo/)
  assert.equal((await run('start', 'shop', '--name', 'x', '--agent', 'claude', '--text', 'go', '--bypass-fullops')).code, 0)
})

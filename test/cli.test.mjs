import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseCommandLine } from '../lib/core.mjs'
import { main } from '../lib/cli.mjs'

// `orca worktree ps` and `orca terminal list` answered in turn from script.json, one entry per call.
const FAKE = `const fs = require('fs')
const key = require('path').basename(__filename) === 'worktree' ? 'ps' : 'terminals'
const seq = JSON.parse(fs.readFileSync('script.json', 'utf8'))[key]
const n = fs.existsSync(key + '.n') ? Number(fs.readFileSync(key + '.n', 'utf8')) : 0
fs.writeFileSync(key + '.n', String(n + 1))
process.stdout.write(JSON.stringify({ ok: true, result: seq[Math.min(n, seq.length - 1)] }))
`

/** Run the CLI against a fake orca (node runs ./worktree or ./terminal in a temp dir). */
async function runWithFakeOrca(script, argv) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-helm-fake-'))
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs"}')
  fs.writeFileSync(path.join(dir, 'worktree'), FAKE)
  fs.writeFileSync(path.join(dir, 'terminal'), FAKE)
  fs.writeFileSync(path.join(dir, 'script.json'), JSON.stringify(script))
  const out = path.join(dir, 'out.json')
  const prev = { cwd: process.cwd(), bin: process.env.ORCA_HELM_BIN }
  process.chdir(dir)
  process.env.ORCA_HELM_BIN = process.execPath
  try {
    const { code, stderr } = await captureStderr(() => main(parseCommandLine([...argv, '--out', out])))
    return { code, stderr, stdout: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '' }
  } finally {
    process.chdir(prev.cwd)
    if (prev.bin === undefined) delete process.env.ORCA_HELM_BIN
    else process.env.ORCA_HELM_BIN = prev.bin
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

const worktree = (id, path, state) => ({
  worktreeId: id,
  repoId: 'r1',
  repo: 'shop',
  path,
  displayName: 'app',
  agents: state ? [{ paneKey: `${id}:leaf`, state, agentType: 'claude', stateStartedAt: Date.now() }] : [],
})
const terminal = (handle, id) => ({ handle, worktreeId: id, tabId: id, leafId: 'leaf', title: 'agent' })

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

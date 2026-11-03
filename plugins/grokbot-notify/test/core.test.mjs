import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseStates, createDebouncer, buildPayload, repoNameFromGit, parseWorkspaces, matchesWorkspace, parseRoutes, savedRouteLine } from '../worker/core.mjs'

test('parseStates defaults when empty or invalid', () => {
  assert.deepEqual([...parseStates('')].sort(), ['blocked', 'done', 'waiting'])
  assert.deepEqual([...parseStates('nope')].sort(), ['blocked', 'done', 'waiting'])
  assert.ok(parseStates('working').has('working'))
})

test('debouncer suppresses same state, allows different state and expiry', () => {
  const shouldSend = createDebouncer()
  assert.equal(shouldSend('k', 'done', 1000, 30_000), true)
  assert.equal(shouldSend('k', 'done', 2000, 30_000), false)
  assert.equal(shouldSend('k', 'waiting', 3000, 30_000), true)
  assert.equal(shouldSend('k', 'waiting', 40_000, 30_000), true)
})

test('buildPayload shape', () => {
  const p = buildPayload(
    {
      state: 'done',
      paneKey: 'p1',
      receivedAt: 1730000000000,
      mainAgent: { outcome: 'success' },
    },
    { worktree: 'wt', repo: null, host: 'box' }
  )
  assert.equal(p.event, 'agent.status.changed')
  assert.equal(p.state, 'done')
  assert.equal(p.outcome, 'success')
  assert.equal(p.paneKey, 'p1')
  assert.equal(p.terminalId, null)
  assert.equal(p.title, null)
  assert.equal(p.workspaceId, null)
  assert.equal(p.receivedAt, new Date(1730000000000).toISOString())
  assert.equal(p.worktree, 'wt')
  assert.equal(p.repo, null)
  assert.equal(p.host, 'box')
  assert.equal(p.branch, null)
  assert.equal(p.text, 'wt: done (success)')
  assert.equal(buildPayload({ state: 'waiting', title: 'fix login' }, {}).text, 'Orca: waiting - fix login')
  assert.equal(buildPayload({ state: 'done' }, { repo: 'shop', worktree: 'main' }).text, 'shop/main: done')
})

test('repoNameFromGit reads the main worktree folder from .git', () => {
  assert.equal(repoNameFromGit('D:/work/shop', null), 'shop')
  assert.equal(repoNameFromGit('D:/wt/feat', 'gitdir: D:/work/shop/.git/worktrees/feat\n'), 'shop')
  assert.equal(repoNameFromGit('/srv/wt/feat', 'gitdir: /srv/shop.git/worktrees/feat'), 'shop')
  assert.equal(repoNameFromGit('/work/shop-wt/feat', 'gitdir: ../../shop/.git/worktrees/feat'), 'shop')
  assert.equal(repoNameFromGit('/x', 'not a git file'), null)
})

test('route workspaces match repo, workspace name or a path part, ignoring case', () => {
  const info = { repo: 'orca-helm', name: 'main', path: 'D:\\workspace\\orca-helm' }
  assert.deepEqual(parseWorkspaces(' Fullops-Squad-plugin , ,ORCA-HELM '), ['fullops-squad-plugin', 'orca-helm'])
  assert.equal(matchesWorkspace(parseWorkspaces(''), info), true)
  assert.equal(matchesWorkspace(parseWorkspaces('Orca-Helm'), info), true)
  assert.equal(matchesWorkspace(parseWorkspaces('MAIN'), info), true)
  assert.equal(matchesWorkspace(parseWorkspaces('workspace/orca'), info), true)
  assert.equal(matchesWorkspace(parseWorkspaces('Fullops-Squad-plugin'), info), false)
  assert.equal(matchesWorkspace(parseWorkspaces('x'), { repo: null, name: null, path: null }), false)
})

test('parseRoutes reads one bot per line and keeps the last line for a name', () => {
  const { routes, errors, rows } = parseRoutes(
    ['# comment', '풀로 | a, B | https://x/1 | Authorization: Bearer 1', '', 'oops', ' | a | https://x', '풀로 | c | https://x/2 | (saved)'].join('\r\n')
  )
  assert.deepEqual(errors, [
    { line: 4, reason: 'expected name | workspaces | URL | Authorization' },
    { line: 5, reason: 'missing bot name' },
  ])
  assert.equal(routes.length, 1)
  assert.deepEqual([routes[0].workspaces, routes[0].saved, routes[0].auth], [['c'], true, null])
  assert.equal(rows.some((row) => row.number === 2), false)
  const first = parseRoutes('풀로 | a | https://x/1 | Authorization: Bearer 1').routes[0]
  assert.equal(first.auth, 'Bearer 1')
  assert.equal(savedRouteLine(first), '풀로 | a | https://x/1 | (saved)')
})

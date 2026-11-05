import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { parseStates, createDebouncer, buildPayload, repoNameFromGit, gitCommonDir, parseWorkspaces, matchesWorkspace, parseRoutes, routeLine, upsertRouteLine, removeRouteLines, routeProblem, workspaceOptions } from '../worker/core.mjs'

test('parseStates defaults when empty or invalid', () => {
  assert.deepEqual([...parseStates('')].sort(), ['blocked', 'done', 'waiting'])
  assert.deepEqual([...parseStates('nope')].sort(), ['blocked', 'done', 'waiting'])
  assert.ok(parseStates('working').has('working'))
})

test('debouncer sends a state only when it changes, plus one reminder once it has lasted remindMs', () => {
  const MIN = 60_000
  const remind = 30 * MIN
  const shouldSend = createDebouncer()
  // Issue #1: the same waiting every 30-60 s for five minutes goes out once.
  assert.equal(shouldSend('t1', 'waiting', 0, remind), true)
  for (let at = 30_000; at <= 5 * MIN; at += 45_000) assert.equal(shouldSend('t1', 'waiting', at, remind), false)
  assert.equal(shouldSend('t1', 'waiting', 31 * MIN, remind), true)
  assert.equal(shouldSend('t1', 'waiting', 90 * MIN, remind), false)
  // Any change counts, so done -> working -> done sends the second done.
  assert.equal(shouldSend('t1', 'done', 91 * MIN, remind), true)
  assert.equal(shouldSend('t1', 'working', 92 * MIN, remind), true)
  assert.equal(shouldSend('t1', 'done', 93 * MIN, remind), true)
  // Terminals are independent, and 0 never reminds.
  assert.equal(shouldSend('t2', 'done', 93 * MIN, 0), true)
  assert.equal(shouldSend('t2', 'done', 999 * MIN, 0), false)

  // Past 200 terminals the one whose state changed longest ago is forgotten.
  const many = createDebouncer()
  for (let i = 0; i <= 200; i++) many(`t${i}`, 'done', i, 0)
  assert.equal(many('t0', 'done', 300, 0), true)
  assert.equal(many('t200', 'done', 300, 0), false)
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
  // FullOps keeps its records in the common directory.
  assert.equal(gitCommonDir('/srv/wt/feat', 'gitdir: /srv/shop.git/worktrees/feat'), path.resolve('/srv/shop.git'))
  assert.equal(gitCommonDir('/work/shop', null), path.resolve('/work/shop/.git'))
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
  assert.equal(routeLine({ ...first, saved: true }), '풀로 | a | https://x/1 | (saved)')
})

test('panel edits: a line is replaced in place or appended, removed by name, and checked first', () => {
  const NL = String.fromCharCode(10)
  const text = ['# bots', 'A | x | https://a | (saved)', 'b | y | https://b', 'a | old | https://a2'].join(NL)
  assert.equal(upsertRouteLine(text, ['a'], 'A | z | https://a3'), ['# bots', 'A | z | https://a3', 'b | y | https://b'].join(NL))
  assert.equal(upsertRouteLine('', ['c'], 'c | | https://c'), 'c | | https://c')
  assert.equal(removeRouteLines(text, 'a'), ['# bots', 'b | y | https://b'].join(NL))
  assert.equal(routeProblem({ name: 'a|b', url: 'https://a', workspaces: [] }), 'a bot name cannot contain | or a line break')
  assert.equal(routeProblem({ name: ' #ops', url: 'https://a', workspaces: [] }), 'a bot name cannot start with #')
  assert.equal(routeProblem({ name: 'a', url: 'ftp://a', workspaces: [] }), 'enter an http(s) routine URL')
  assert.equal(routeProblem({ name: 'a', url: 'https://a', workspaces: ['x,y'] }), 'a workspace cannot contain , or |')
  assert.equal(routeProblem({ name: 'a', url: 'https://a', workspaces: ['x'] }), null)
  assert.deepEqual(workspaceOptions([{ repo: 'shop', name: 'main' }, { repo: 'SHOP', name: 'dev' }, { repo: null, name: 'notes' }]), ['notes', 'shop'])
})

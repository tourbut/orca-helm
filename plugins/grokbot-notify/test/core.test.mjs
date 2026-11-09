import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { parseStates, createDebouncer, buildPayload, repoNameFromGit, gitCommonDir, parseWorkspaces, matchesWorkspace, parseRoutes, routeLine, upsertRouteLine, removeRouteLines, routeProblem, workspaceOptions, maskSecrets, tailNeedsInput, tailText } from '../worker/core.mjs'

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

test('debouncer sends the same state again only when the tail changed', () => {
  const shouldSend = createDebouncer()
  assert.equal(shouldSend('t', 'done', 0, 0, 'a'), true)
  assert.equal(shouldSend('t', 'done', 1, 0, 'a'), false)
  assert.equal(shouldSend('t', 'done', 2, 0, 'b'), true)
  // An unreadable tail says nothing changed, and a read that works again compares with the last known one.
  assert.equal(shouldSend('t', 'done', 3, 0, null), false)
  assert.equal(shouldSend('t', 'done', 4, 0, 'b'), false)
  // New output restarts the reminder clock.
  const remind = createDebouncer()
  remind('t', 'waiting', 0, 100, 'a')
  assert.equal(remind('t', 'waiting', 90, 100, 'b'), true)
  assert.equal(remind('t', 'waiting', 110, 100, 'b'), false)
  assert.equal(remind('t', 'waiting', 190, 100, 'b'), true)
})

test('maskSecrets hides common tokens and leaves ordinary text', () => {
  const hex = 'ab12'.repeat(10)
  const b64 = 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0fI+/x='
  assert.equal(
    maskSecrets(`Authorization: Bearer s3cret\nkey=sk-ant-api03-abc_DEF-123 ghp_abcdefghij0123 commit ${hex}\n${b64}`),
    'Authorization: Bearer [REDACTED]\nkey=[REDACTED] [REDACTED] commit [REDACTED]\n[REDACTED]'
  )
  for (const kept of ['task-management risk-free-option', 'plugins/grokbot-notify/worker/core/worker/core/main', '4f8233dd-206d-467d-a10c-69c14eb57e14', 'release 1.21.0']) {
    assert.equal(maskSecrets(kept), kept)
  }
})

test('tailText keeps the conversation, masks, and cuts to about 1500 characters at a line start', () => {
  const rule = '─'.repeat(40)
  assert.equal(tailText(['\u001b[31m● 병합할까요?\u001b[0m', rule, '❯', rule, '  ⏵⏵ bypass permissions on · ctx 22% · 782k left']), '● 병합할까요?')
  assert.equal(tailText([rule, '❯ draft', rule]), null)
  assert.equal(tailText([]), null)

  const long = tailText(['sk-abcdefgh12345678', ...Array.from({ length: 300 }, (_, i) => `line ${i}`)])
  assert.ok(long.length <= 1500)
  assert.ok(long.startsWith('line '))
  assert.ok(long.endsWith('line 299'))
  // Masked before the cut, so a cut through a token cannot leave its end without the prefix the mask needs.
  const straddle = tailText([`ghp_${'x'.repeat(40)}`, 'y'.repeat(1490)])
  assert.ok(!straddle.includes('xxxx'))
})

test('tailNeedsInput follows fixed rules over the last lines', () => {
  // Issue #3: the question sits above a closing note.
  assert.equal(tailNeedsInput(['1.21.0을 릴리스하고 #82의 P5를 체크할까요? 승인 범위가 병합까지여서 둘 다 하지 않았습니다.', '', '#82에는 측정이 남아 있습니다.'].join('\n')), true)
  for (const asks of ['Do you want to proceed?', '바로 병합해서 푸시할까요', '지금 올리길 원하시면 말씀해 주세요.', 'Overwrite? [y/N]', '계속할까요？']) {
    assert.equal(tailNeedsInput(asks), true, asks)
  }
  for (const says of ['테스트 통과. PR을 올렸습니다.', 'const a = b ? c : d', 'see a?b=1 and x?.y', '']) {
    assert.equal(tailNeedsInput(says), false, says)
  }
  assert.equal(tailNeedsInput(null), false)
  // A question further up is an old one.
  assert.equal(tailNeedsInput(['할까요?', ...Array.from({ length: 8 }, (_, i) => `done ${i}`)].join('\n')), false)
})

test('buildPayload adds tail and needsInput and leaves the other fields', () => {
  const plain = buildPayload({ state: 'done' }, {})
  assert.deepEqual([plain.tail, plain.needsInput], [null, false])
  const asked = buildPayload({ state: 'done' }, { tail: '릴리스할까요?' })
  assert.deepEqual([asked.tail, asked.needsInput, asked.text], ['릴리스할까요?', true, 'Orca: done'])
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

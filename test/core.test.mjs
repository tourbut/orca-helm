import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRows, classifyState, findMatches, fuzzyScore, parseArgs, sortRows, tailLines, unwrap } from '../lib/core.mjs'

test('unwrap prefers an RPC result and passes plain objects through', () => {
  assert.deepEqual(unwrap({ ok: true, id: 1, result: { repos: [] } }), { repos: [] })
  assert.deepEqual(unwrap({ repos: [1] }), { repos: [1] })
  assert.equal(unwrap({ result: 0 }), 0)
  assert.equal(unwrap(null), null)
  assert.equal(unwrap('x'), 'x')
})

test('parseArgs reads positionals, flags, booleans, and passthrough', () => {
  const args = parseArgs(['status', 'fullops', '--all', '--lines', '40', '--file=p.txt', '--', 'terminal', 'list'])
  assert.deepEqual(args.positionals, ['status', 'fullops'])
  assert.equal(args.flags.all, true)
  assert.equal(args.flags.lines, '40')
  assert.equal(args.flags.file, 'p.txt')
  assert.deepEqual(args.rest, ['terminal', 'list'])
})

test('fuzzyScore orders exact, prefix, substring, subsequence, including Hangul', () => {
  const exact = fuzzyScore('fullops', 'fullops')
  const prefix = fuzzyScore('fullops', 'fullops-main')
  const mid = fuzzyScore('fullops', 'xx-fullops-yy')
  const seq = fuzzyScore('fullops', 'f x u l l o p s z')
  const none = fuzzyScore('fullops', 'other')
  assert.ok(exact > prefix && prefix > mid && mid > seq && seq > none)
  assert.equal(none, 0)
  assert.equal(fuzzyScore('풀-옵', '풀옵'), 400)
  assert.ok(fuzzyScore('풀옵', '풀옵') > fuzzyScore('풀옵', '풀옵스'))
  assert.ok(fuzzyScore('풀옵', '풀옵스') > fuzzyScore('풀옵', '내 풀옵스'))
  assert.ok(fuzzyScore('풀옵', '내 풀옵스') > fuzzyScore('풀옵', '풀x옵'))
  assert.equal(fuzzyScore('풀옵', '메인'), 0)
})

test('buildRows joins a terminal to its agent by paneKey', () => {
  const preview = `${'가'.repeat(90)} tail`
  const ps = {
    worktrees: [
      {
        worktreeId: 'wt1',
        repoId: 'r1',
        repo: 'fullops',
        path: '/src/fullops',
        branch: 'main',
        displayName: 'main',
        isArchived: false,
        status: 'working',
        preview: 'workspace',
        agents: [
          {
            paneKey: 'tab1:leaf1',
            state: 'waiting',
            agentType: 'claude',
            taskTitle: 'fix login',
            stateStartedAt: 1_700_000_000_000,
            lastAssistantMessage: preview,
          },
        ],
      },
      {
        worktreeId: 'wt2',
        repoId: 'r1',
        repo: 'fullops',
        path: '/src/fullops-arch',
        branch: 'old',
        displayName: 'old',
        isArchived: true,
        status: 'inactive',
        agents: [],
      },
      {
        worktreeId: 'wt3',
        repoId: 'r1',
        repo: 'fullops',
        path: '/src/empty',
        branch: 'feat',
        displayName: '',
        isArchived: false,
        status: 'inactive',
        agents: [],
        preview: 'no terms',
      },
    ],
  }
  const terminals = {
    terminals: [
      { handle: 'h1', worktreeId: 'wt1', tabId: 'tab1', leafId: 'leaf1', title: 'Claude', branch: 'main', preview: 'term' },
      { handle: 'h2', worktreeId: 'wt1', tabId: 'tab1', leafId: 'leaf2', title: null, paneTitle: 'shell', branch: 'main', preview: 'shell out' },
      { handle: 'h-arch', worktreeId: 'wt2', tabId: 't', leafId: 'l', title: 'archived' },
    ],
  }
  const rows = buildRows(ps, terminals)
  assert.equal(rows.length, 3)
  const joined = rows.find((row) => row.handle === 'h1')
  assert.equal(joined.state, 'waiting')
  assert.equal(joined.agent, 'claude')
  assert.equal(joined.title, 'Claude')
  assert.equal(joined.worktree, 'main')
  assert.equal(joined.since, 1_700_000_000_000)
  assert.equal(joined.preview.length, 80)
  const shell = rows.find((row) => row.handle === 'h2')
  assert.equal(shell.state, 'shell')
  assert.equal(shell.agent, null)
  assert.equal(shell.title, 'shell')
  const empty = rows.find((row) => row.worktreeId === 'wt3')
  assert.equal(empty.handle, null)
  assert.equal(empty.worktree, 'feat')
  assert.equal(empty.preview, 'no terms')
  assert.equal(buildRows(ps, terminals, { all: true }).some((row) => row.worktreeId === 'wt2'), true)
})

test('classifyState buckets permission and blocked with waiting', () => {
  assert.equal(classifyState('working'), 'working')
  assert.equal(classifyState('permission'), 'waiting')
  assert.equal(classifyState('blocked'), 'waiting')
  assert.equal(classifyState('waiting'), 'waiting')
  assert.equal(classifyState('done'), 'done')
  assert.equal(classifyState('shell'), 'shell')
  assert.equal(classifyState('idle'), 'idle')
  assert.equal(classifyState('inactive'), 'idle')
  assert.equal(classifyState('active'), 'idle')
  assert.equal(classifyState('nope'), 'unknown')
  assert.equal(classifyState(null), 'unknown')
})

test('bare terminals are shell and shared labels stay distinct', () => {
  const mainId = '79710d8d::D:/workspace/jevpet'
  const aId = '79710d8d::D:/workspace/jevpet-worktrees/.fullops-review-982c69f16a5644fd82b7c207379ecd72'
  const bId = '79710d8d::D:/workspace/jevpet-worktrees/.fullops-review-d3ec5272519e4a2ea95d13a9a86449f3'
  const ps = {
    worktrees: [
      { worktreeId: mainId, repo: 'jevpet', path: 'D:/workspace/jevpet', displayName: 'main', status: 'active', agents: [] },
      {
        worktreeId: aId,
        repo: 'jevpet',
        path: 'D:/workspace/jevpet-worktrees/.fullops-review-982c69f16a5644fd82b7c207379ecd72',
        displayName: 'jevpet',
        branch: '',
        status: 'inactive',
        agents: [],
      },
      {
        worktreeId: bId,
        repo: 'jevpet',
        path: 'D:/workspace/jevpet-worktrees/.fullops-review-d3ec5272519e4a2ea95d13a9a86449f3',
        displayName: 'jevpet',
        branch: '',
        status: 'inactive',
        agents: [],
      },
      {
        worktreeId: 'wt-done',
        repo: 'jevpet',
        path: 'D:/workspace/done',
        displayName: 'done',
        status: 'active',
        agents: [{ paneKey: 'tab:leaf', state: 'done', agentType: 'claude' }],
      },
      { worktreeId: 'id-aaaabbbb', repo: 'box', path: 'D:/wt/alpha', displayName: 'same', status: 'inactive', agents: [] },
      { worktreeId: 'id-ccccdddd', repo: 'box', path: 'D:/wt/beta', displayName: 'same', status: 'inactive', agents: [] },
      { worktreeId: 'xxxxAAAA1111', repo: 'box', path: 'D:/one/leaf', displayName: 'dup', status: 'inactive', agents: [] },
      { worktreeId: 'yyyyBBBB2222', repo: 'box', path: 'D:/two/leaf', displayName: 'dup', status: 'inactive', agents: [] },
      {
        worktreeId: 'aa111111',
        repo: 'box',
        path: 'D:/r/.fullops-review-982c69f1AAAAAAAA',
        displayName: 'long',
        status: 'inactive',
        agents: [],
      },
      {
        worktreeId: 'bb222222',
        repo: 'box',
        path: 'D:/r/.fullops-review-982c69f1BBBBBBBB',
        displayName: 'long',
        status: 'inactive',
        agents: [],
      },
    ],
  }
  const terminals = {
    terminals: [
      { handle: 'term_a24f', worktreeId: mainId, tabId: 'pty:main', leafId: 'pty:main', title: null, paneTitle: null, agentIdentity: null },
      { handle: 'term_a24f', worktreeId: mainId, tabId: 'pty:main', leafId: 'pty:main', title: null, paneTitle: null, agentIdentity: null },
      { handle: 'term_claude_only', worktreeId: aId, tabId: 't1', leafId: 'l1', title: null, agentIdentity: 'claude' },
      { handle: 'term_plain', worktreeId: aId, tabId: 't2', leafId: 'l2', title: null, agentIdentity: null },
      { handle: 'term_done', worktreeId: 'wt-done', tabId: 'tab', leafId: 'leaf', title: null, agentIdentity: 'claude' },
    ],
  }
  const rows = buildRows(ps, terminals)
  assert.equal(rows.filter((row) => row.handle === 'term_a24f').length, 1)
  const main = rows.find((row) => row.handle === 'term_a24f')
  assert.equal(main.state, 'shell')
  assert.equal(main.agent, null)
  assert.equal(main.worktree, 'main')

  const claudeOnly = rows.find((row) => row.handle === 'term_claude_only')
  const plain = rows.find((row) => row.handle === 'term_plain')
  assert.equal(claudeOnly.state, 'shell')
  assert.equal(claudeOnly.agent, 'claude')
  assert.equal(claudeOnly.worktree, 'jevpet~982c69f1')
  assert.equal(plain.worktree, claudeOnly.worktree)
  assert.equal(plain.agent, null)
  assert.equal(rows.find((row) => row.worktreeId === bId).worktree, 'jevpet~d3ec5272')

  const done = rows.find((row) => row.handle === 'term_done')
  assert.equal(done.state, 'done')
  assert.equal(done.agent, 'claude')

  assert.equal(rows.find((row) => row.worktreeId === 'id-aaaabbbb').worktree, 'same~alpha')
  assert.equal(rows.find((row) => row.worktreeId === 'id-ccccdddd').worktree, 'same~beta')
  assert.equal(rows.find((row) => row.worktreeId === 'xxxxAAAA1111').worktree, 'dup~AAAA1111')
  assert.equal(rows.find((row) => row.worktreeId === 'yyyyBBBB2222').worktree, 'dup~BBBB2222')
  assert.equal(rows.find((row) => row.worktreeId === 'aa111111').worktree, 'long~69f1AAAAAAAA')
  assert.equal(rows.find((row) => row.worktreeId === 'bb222222').worktree, 'long~69f1BBBBBBBB')

  const named = findMatches(rows, [], 'same').find((match) => match.row.worktreeId === 'id-aaaabbbb')
  assert.equal(named.score, 400)
  assert.ok(findMatches(rows, [], 'jevpet').some((match) => match.row.worktree === 'jevpet~982c69f1'))
  assert.deepEqual(
    sortRows([
      { repo: 'a', worktree: 'i', state: 'idle' },
      { repo: 'a', worktree: 's', state: 'shell' },
      { repo: 'a', worktree: 'd', state: 'done' },
    ]).map((row) => row.state),
    ['done', 'shell', 'idle'],
  )
})

test('tailLines drops ANSI and trailing blank lines', () => {
  assert.deepEqual(tailLines(['keep', '\u001b[1;31mhi\u001b[0m', '', '  '], 2), ['keep', 'hi'])
  assert.deepEqual(tailLines(['\u001b[31mred\u001b[0m', ''], 40), ['red'])
  assert.deepEqual(tailLines(['a', 'b', 'c'], 1), ['c'])
})

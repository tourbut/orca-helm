import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildRows, classifyState, fuzzyScore, parseArgs, tailLines, unwrap } from '../lib/core.mjs'

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
  assert.equal(shell.state, 'working')
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
  assert.equal(classifyState('idle'), 'idle')
  assert.equal(classifyState('inactive'), 'idle')
  assert.equal(classifyState('nope'), 'unknown')
  assert.equal(classifyState(null), 'unknown')
})

test('tailLines drops ANSI and trailing blank lines', () => {
  assert.deepEqual(tailLines(['keep', '\u001b[1;31mhi\u001b[0m', '', '  '], 2), ['keep', 'hi'])
  assert.deepEqual(tailLines(['\u001b[31mred\u001b[0m', ''], 40), ['red'])
  assert.deepEqual(tailLines(['a', 'b', 'c'], 1), ['c'])
})

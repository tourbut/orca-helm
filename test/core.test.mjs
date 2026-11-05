import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildRows, classifyState, findMatches, fuzzyScore, parseArgs, parseCommandLine, pickTarget, plainLines, sortRows, tailLines, unwrap } from '../lib/core.mjs'
import { resolveOrcaBin } from '../lib/orca.mjs'

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
  const dash = parseArgs(['send', 'x', '--text', '- item', '--lines', '-1', '--all', '--no-enter'])
  assert.deepEqual(dash.positionals, ['send', 'x'])
  assert.equal(dash.flags.text, '- item')
  assert.equal(dash.flags.lines, '-1')
  assert.equal(dash.flags['no-enter'], true)
})

test('parseCommandLine peels --out for every command and passes raw through', () => {
  const raw = parseCommandLine(['--out', 'o.txt', 'raw', '--', 'worktree', 'ps', '--json'])
  assert.deepEqual(raw.positionals, ['raw'])
  assert.deepEqual(raw.rest, ['worktree', 'ps', '--json'])
  assert.equal(raw.flags.out, 'o.txt')
  // PowerShell drops `--`; flags after raw still belong to orca, and `--out` after `--` too.
  assert.deepEqual(parseCommandLine(['raw', 'terminal', 'read', '--lines', '5']).rest, ['terminal', 'read', '--lines', '5'])
  assert.deepEqual(parseCommandLine(['raw', '--', 'x', '--out', 'y']).rest, ['x', '--out', 'y'])
  const status = parseCommandLine(['status', '--out=s.txt', '--json'])
  assert.deepEqual(status.positionals, ['status'])
  assert.equal(status.flags.out, 's.txt')
  assert.equal(status.flags.json, true)
  assert.equal(parseCommandLine(['status', '--out']).flags.out, true)
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
  // send presses Enter, so the tie-break must pick the agent terminal, never the plain shell.
  assert.equal(pickTarget(rows, 'jevpet~982c69f1').row.handle, 'term_claude_only')
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

  const slash = findMatches(rows, [], 'jevpet/main')
  assert.equal(slash.filter((match) => match.score === 400).length, 1)
  assert.equal(slash.find((match) => match.score === 400).row.handle, 'term_a24f')
  const linkRows = [{ repo: 'KnowsLink', worktree: 'coor', branch: '', title: '', handle: 'hk', worktreeId: 'wk', repoId: 'rk' }]
  assert.equal(findMatches(linkRows, [], 'KnowsLink/coor')[0].score, 400)
  assert.equal(findMatches(linkRows, [], 'knowslink/coor')[0].row.handle, 'hk')
  assert.equal(pickTarget(linkRows, 'KnowsLink/coor').row.handle, 'hk')

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

test('a label status prints resolves in read/send/wait even with an archived worktree of the same name', () => {
  const twin = (hex, isArchived) => ({
    worktreeId: `r::D:/wt/.fullops-review-${hex}`,
    repo: 'jevpet',
    path: `D:/wt/.fullops-review-${hex}`,
    displayName: 'jevpet',
    isArchived,
    agents: [],
  })
  const ps = { worktrees: [twin(`1752fe0c${'a'.repeat(24)}`, false), twin(`f6113ddd${'b'.repeat(24)}`, true)] }
  const terminals = { terminals: [{ handle: 'term_live', worktreeId: ps.worktrees[0].worktreeId, tabId: 't', leafId: 'l' }] }
  const shown = buildRows(ps, terminals)
  assert.deepEqual(shown.map((row) => row.worktree), ['jevpet~1752fe0c'])
  assert.equal(pickTarget(buildRows(ps, terminals, { all: true }), `jevpet/${shown[0].worktree}`).row.handle, 'term_live')
})

test('labels stay with their worktree when worktree ps lists them in another order', () => {
  // The same folder name under two roots: base, head8, last12 and the id's last 8 characters all collide.
  const coor = (root) => ({ worktreeId: `r::${root}/jevpet/coor`, repo: 'jevpet', path: `${root}/jevpet/coor`, displayName: 'coor', agents: [] })
  const [a, b] = [coor('C:/Users/me/orca/workspaces'), coor('D:/orca/workspaces')]
  const terminals = {
    terminals: [
      { handle: 'term_a', worktreeId: a.worktreeId, tabId: 't', leafId: 'l' },
      { handle: 'term_b', worktreeId: b.worktreeId, tabId: 't', leafId: 'l' },
    ],
  }
  const labels = (worktrees) => Object.fromEntries(buildRows({ worktrees }, terminals).map((row) => [row.handle, row.worktree]))
  const listed = labels([a, b])
  assert.notEqual(listed.term_a, listed.term_b)
  assert.deepEqual(labels([b, a]), listed)
})

test('tailLines drops ANSI and trailing blank lines', () => {
  assert.deepEqual(tailLines(['keep', '\u001b[1;31mhi\u001b[0m', '', '  '], 2), ['keep', 'hi'])
  assert.deepEqual(tailLines(['\u001b[31mred\u001b[0m', ''], 40), ['red'])
  assert.deepEqual(tailLines(['a', 'b', 'c'], 1), ['c'])
  assert.deepEqual(tailLines(['a', 'b', 'c'], 0), [])
})

test('plainLines drops TUI chrome and keeps the conversation', () => {
  const rule = '─'.repeat(24)
  const lines = [
    '> ship the fix',
    '● updated login',
    '  still in the same message',
    '  - Still open:',
    '    - When a customer types two lines about 4 seconds apart, they still get two replies (seen once, in L-30).',
    '  The pre-existing change to waiver.json is still uncommitted.',
    '',
    '',
    '  ⎿  Read ..\\scratchpad\\x.py (12 lines)',
    '     8a9b-22db9643bc20/scratchpad/replay-all.txt',
    '      33 -|const old = 1',
    '      33 +|const next = 2',
    '  ⎿  Allowed by auto mode',
    '  ⎿  Successfully loaded skill',
    '  ⎿  Referenced file agent/graph.py',
    '  ⎿  Skills restored (ego-browser, fullops-squad:update-fullops)',
    '  Ran 3 shell commands',
    '  Read 1 file, ran 5 shell commands',
    '✻ Churned for 4m 48s · done 10:42 PM',
    '✻ Cogitated for 7m 9s · done 12:33 AM',
    '※ recap: tightened the check',
    '  (disable recaps in /config)',
    '※ recap: The three failed',
    '  cases now pass, and it is pushed as cc45359.',
    '  3-second merge wait. (disable recaps in /config)',
    '⏺ Compacted while idle, before the prompt cache expired · turn off with "idleCompaction": false in',
    '  settings.json',
    '● Compacted while idle, before the prompt cache expired in',
    '  settings.json',
    '⏺ kept after compact',
    '  still the reply',
    ' ☀  Clear  23% of context  228.8k / 1M   last turns ▆▆█',
    `${' '.repeat(20)}✔ Update installed · Restart to update`,
    `❯${rule}`,
    '❯ fix',
    rule,
    '  ⏵⏵ auto mode on (shift+tab to cycle) · ctx 33%',
    '  ⏵⏵ bypass permissions on · 1 shell, 1 monitor · ↓ to manage',
  ]
  assert.deepEqual(plainLines(lines), [
    '> ship the fix',
    '● updated login',
    '  still in the same message',
    '  - Still open:',
    '    - When a customer types two lines about 4 seconds apart, they still get two replies (seen once, in L-30).',
    '  The pre-existing change to waiver.json is still uncommitted.',
    '',
    '      33 -|const old = 1',
    '      33 +|const next = 2',
    '⏺ kept after compact',
    '  still the reply',
  ])
})

test('plainLines keeps the main column and strips borders and ANSI', () => {
  assert.deepEqual(
    plainLines([
      '\u001b[32m● hello\u001b[0m │ Workers │',
      '│ keep me │ Reviews │',
      '│ Flow │',
      '╭────╮',
      '│ inside │',
      '╰────╯',
    ]),
    ['● hello', 'keep me', 'inside'],
  )
})

test('plainLines keeps content lines: brackets, text after a box, prose, words in a box', () => {
  assert.deepEqual(
    plainLines([
      '● code:',
      '  if (x) {',
      '  }',
      '});',
      ')',
      '...',
      'This uses 50% of context windows.',
      '╭────╮',
      '│ box │',
      '╰────╯',
      'after the box',
      '│ git push origin main │',
      '│ Workers 3 │',
      '  ⎿  Added 2 lines',
      '      340  })',
      "      342 +const box = '╭─╮'",
      '─────────── my-session ─',
      '❯ next prompt',
      '───────────',
    ]),
    [
      '● code:',
      '  if (x) {',
      '  }',
      '});',
      ')',
      '...',
      'This uses 50% of context windows.',
      'box',
      'after the box',
      'git push origin main',
      "      342 +const box = '╭─╮'",
    ],
  )
})

test('resolveOrcaBin honors a stub on PATH, or the install folder on Windows', () => {
  const win = process.platform === 'win32'
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-helm-'))
  const name = process.platform === 'linux' ? 'orca-ide' : 'orca'
  const stub = win ? path.join(dir, 'Programs', 'orca', 'resources', 'bin', 'orca.exe') : path.join(dir, name)
  fs.mkdirSync(path.dirname(stub), { recursive: true })
  fs.writeFileSync(stub, '#!/bin/sh\nexit 0\n')
  fs.chmodSync(stub, 0o755)
  // Windows: PATH holds only a foreign orca.cmd, which must not stop the lookup before the install folder.
  if (win) fs.writeFileSync(path.join(dir, 'orca.cmd'), '@echo off\r\n')
  const prev = { PATH: process.env.PATH, ORCA_HELM_BIN: process.env.ORCA_HELM_BIN, LOCALAPPDATA: process.env.LOCALAPPDATA }
  delete process.env.ORCA_HELM_BIN
  process.env.PATH = win ? dir : `${dir}${path.delimiter}${prev.PATH ?? ''}`
  if (win) process.env.LOCALAPPDATA = dir
  try {
    assert.equal(resolveOrcaBin(), stub)
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

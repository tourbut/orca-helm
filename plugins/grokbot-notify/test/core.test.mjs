import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseStates, createDebouncer, buildPayload } from '../worker/core.mjs'

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
})

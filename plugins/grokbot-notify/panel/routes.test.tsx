// `orca plugin test` runs this in Node with Orca's own runtime: the panel and the real worker share one
// stand-in host, so every plugin.request reaches worker/main.mjs. (`npm test` runs the .mjs tests only.)
import { assert, mockHost, mount, mountWorker, test } from 'orca/testing'
import * as worker from '../worker/main.mjs'
import * as panel from './routes'

const workspaces = {
  workspaces: [
    { id: 'w1', kind: 'worktree', name: 'main', path: '/nowhere/orca-helm', branch: 'main', hostId: null },
    { id: 'w2', kind: 'folder', name: 'notes', path: '/nowhere/notes', branch: null, hostId: null },
  ],
  truncated: false,
}

test('a bot is added, edited and deleted with fields and checkboxes; its Authorization only reaches secrets', async () => {
  // The manifest's capabilities: workspace:read for workspace.list, settings:own and secrets:own.
  const host = mockHost({
    capabilities: ['agent:read', 'workspace:read', 'settings:own', 'secrets:own'],
    results: { 'workspace.list': workspaces },
    settings: { routes: '' },
  })
  const bot = await mountWorker(worker, { host, events: ['agent.status.changed'] })
  const view = await mount(panel, { host, locale: 'ko' })
  try {
    await view.press({ text: '봇 추가' })
    await view.type({ label: '봇 이름' }, '풀로')
    await view.type({ label: 'Grok Bot routine URL' }, 'https://example.invalid/r1')
    await view.type({ label: 'Authorization value' }, 'Authorization: Bearer s3cret')
    await view.toggle({ label: 'notes' })
    await view.press({ text: '저장' })

    assert.equal(host.data().settings.routes, '풀로 | notes | https://example.invalid/r1 | (saved)')
    assert.deepEqual(Object.values(host.data().secrets), ['Bearer s3cret'])
    assert.ok(view.find({ text: 'Authorization 저장됨' }))
    assert.equal(JSON.stringify(view.tree()).includes('s3cret'), false)

    // Renaming keeps the saved Authorization; an empty field means "keep".
    await view.press({ text: '편집' })
    await view.type({ label: '봇 이름' }, '노리', { replace: true })
    await view.toggle({ label: 'main' })
    await view.press({ text: '저장' })
    assert.equal(host.data().settings.routes, '노리 | notes,main | https://example.invalid/r1 | (saved)')
    assert.deepEqual(Object.values(host.data().secrets), ['Bearer s3cret'])

    await view.press({ text: '편집' })
    await view.press({ text: '삭제' })
    await view.press({ text: '이 봇 삭제' })
    assert.equal(host.data().settings.routes, '')
    assert.deepEqual(host.data().secrets, {})
    assert.ok(view.find({ label: '아직 봇이 없습니다' }))

    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.warnings, [])
    assert.deepEqual(view.refusals, [])
  } finally {
    await view.unmount()
    await bot.deactivate()
  }
})

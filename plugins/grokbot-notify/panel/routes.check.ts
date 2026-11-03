// `orca plugin check` renders the panel once per scenario, with the worker on a fresh stand-in host.
import { defineCheck } from 'orca/testing'

const workspaces = {
  workspaces: [
    { id: 'w1', kind: 'worktree', name: 'main', path: '/nowhere/orca-helm', branch: 'main', hostId: null },
    { id: 'w2', kind: 'folder', name: 'notes', path: '/nowhere/notes', branch: null, hostId: null },
  ],
  truncated: false,
}

export default defineCheck({
  empty: { results: { 'workspace.list': workspaces } },
  routes: {
    results: { 'workspace.list': workspaces },
    settings: {
      routes: [
        '풀로 | orca-helm,Fullops-Squad-plugin | https://example.invalid/r1 | (saved)',
        '노리 | jevpet | https://example.invalid/r2',
        'broken line',
      ].join('\n'),
    },
    // The key worker/main.mjs derives for 풀로.
    secrets: { route_585a29126a02ed3f: 'Bearer check' },
  },
})

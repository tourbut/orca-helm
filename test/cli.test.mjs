import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseCommandLine } from '../lib/core.mjs'
import { main } from '../lib/cli.mjs'

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

test('an extra positional argument exits 1 with the usage line', async () => {
  for (const argv of [['status', 'shop', 'main'], ['read', 'x', '--', 'y'], ['help', 'status']]) {
    const { code, stderr } = await captureStderr(() => main(parseCommandLine(argv)))
    assert.equal(code, 1, argv.join(' '))
    assert.match(stderr, /unexpected argument "(main|y|status)"/)
    assert.match(stderr, new RegExp(`usage: orca-helm ${argv[0]} `))
  }
})

#!/usr/bin/env node
import { isFlagValue, parseArgs } from '../lib/core.mjs'
import { main } from '../lib/cli.mjs'

function peelOut(argv) {
  let out
  const kept = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--') {
      kept.push(...argv.slice(i))
      break
    }
    if (token === '--out') {
      const next = argv[i + 1]
      if (isFlagValue(next)) {
        out = next
        i += 1
      } else out = true
      continue
    }
    if (token.startsWith('--out=')) {
      out = token.slice('--out='.length)
      continue
    }
    kept.push(token)
  }
  return { out, argv: kept }
}

const argv = process.argv.slice(2)
const peeled = peelOut(argv)
// PowerShell swallows `--`, so everything after `raw` is orca's argv. Drop one leading `--`.
const args = peeled.argv[0] === 'raw'
  ? {
      positionals: ['raw'],
      flags: {},
      rest: peeled.argv[1] === '--' ? peeled.argv.slice(2) : peeled.argv.slice(1),
    }
  : parseArgs(peeled.argv)
if (peeled.out !== undefined) args.flags.out = peeled.out

const code = await main(args)
process.exitCode = code ?? 0

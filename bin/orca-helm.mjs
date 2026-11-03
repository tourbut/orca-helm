#!/usr/bin/env node
import { parseArgs } from '../lib/core.mjs'
import { main } from '../lib/cli.mjs'

const argv = process.argv.slice(2)
// PowerShell swallows `--`, so everything after `raw` is orca's argv. Drop one leading `--`.
const args = argv[0] === 'raw'
  ? { positionals: ['raw'], flags: {}, rest: argv[1] === '--' ? argv.slice(2) : argv.slice(1) }
  : parseArgs(argv)

const code = await main(args)
process.exitCode = code ?? 0

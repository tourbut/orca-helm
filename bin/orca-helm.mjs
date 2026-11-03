#!/usr/bin/env node
import { parseArgs } from '../lib/core.mjs'
import { main } from '../lib/cli.mjs'

const code = await main(parseArgs(process.argv.slice(2)))
process.exitCode = code ?? 0

#!/usr/bin/env node
import { parseCommandLine } from '../lib/core.mjs'
import { main } from '../lib/cli.mjs'

process.exitCode = await main(parseCommandLine(process.argv.slice(2)))

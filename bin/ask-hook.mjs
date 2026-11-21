#!/usr/bin/env node
// Claude Code PreToolUse hook for AskUserQuestion (hooks/hooks.json). In an Orca terminal it hands the question card
// to Grok Bot through the grokbot-notify plugin and waits for `orca-helm answer`; the answer goes back as
// permissionDecision "allow" with updatedInput.answers, the way Claude Code's hook docs answer AskUserQuestion.
// No output means Claude Code shows the card as usual: outside Orca, when no bot takes it, or when time runs out.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { ASK_VERSION, askDir, askFile, loadJson, saveJson } from '../lib/ask.mjs'

const POLL_MS = 500
// The plugin writes <id>.sent.json once it has tried every bot; a worker Orca has to wake first takes a few seconds.
const SENT_MS = Number(process.env.ORCA_HELM_ASK_SENT_WAIT ?? 30) * 1000
// Keep below the hook's `timeout` in hooks/hooks.json, so this exits (and cleans up) before Claude Code stops it.
const WAIT_MS = Number(process.env.ORCA_HELM_ASK_WAIT ?? 300) * 1000

const input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}')
const tool = input.tool_input ?? {}
const workspaceId = process.env.ORCA_WORKSPACE_ID
if (input.tool_name !== 'AskUserQuestion' || !workspaceId || !Array.isArray(tool.questions) || tool.questions.length === 0 || tool.answers) {
  process.exit(0)
}

const dir = askDir()
const id = `Q${createHash('sha256').update(String(input.tool_use_id ?? `${input.session_id}:${process.pid}:${Date.now()}`)).digest('hex').slice(0, 8)}`
const files = [askFile(dir, id), askFile(dir, id, 'sent'), askFile(dir, id, 'answer')]
const start = Date.now()
const until = start + WAIT_MS

async function waitForAnswer() {
  while (Date.now() < until) {
    const answer = loadJson(files[2])
    if (answer?.answers) return answer
    const sent = loadJson(files[1])
    if (sent ? !(sent.routes?.length > 0) : Date.now() - start > SENT_MS) return null
    await delay(POLL_MS)
  }
  return null
}

let answer = null
try {
  fs.mkdirSync(dir, { recursive: true })
  saveJson(files[0], {
    version: ASK_VERSION,
    id,
    workspaceId,
    terminal: process.env.ORCA_TERMINAL_HANDLE ?? null,
    questions: tool.questions,
    createdAt: new Date(start).toISOString(),
    until: new Date(until).toISOString(),
  })
  answer = await waitForAnswer()
} catch (err) {
  // The card still works without the bot: report and fall through to it.
  process.stderr.write(`orca-helm ask-hook: ${err?.message ?? err}\n`)
} finally {
  for (const file of files) fs.rmSync(file, { force: true })
}

if (answer) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason: `answered through Grok Bot by ${answer.by}`,
        updatedInput: { ...tool, answers: answer.answers },
      },
    })
  )
}

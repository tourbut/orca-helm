import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { answersFor, askFile, saveJson } from '../lib/ask.mjs'
import { parseCommandLine } from '../lib/core.mjs'
import { main } from '../lib/cli.mjs'
import { questionPayload } from '../plugins/grokbot-notify/worker/core.mjs'

const HOOK = fileURLToPath(new URL('../bin/ask-hook.mjs', import.meta.url))
const QUESTIONS = [
  { question: 'Which framework?', header: 'Framework', multiSelect: false, options: [{ label: 'React' }, { label: 'Vue' }] },
  { question: 'Which checks?', header: 'Checks', multiSelect: true, options: [{ label: 'lint' }, { label: 'test' }] },
]

test('answersFor maps each question to its label, joins a multiSelect, and refuses other labels', () => {
  assert.deepEqual(answersFor(QUESTIONS, ['Vue', ['lint', 'test']]), { 'Which framework?': 'Vue', 'Which checks?': 'lint, test' })
  assert.throws(() => answersFor(QUESTIONS, ['Vue']), /expected 2 answer/)
  assert.throws(() => answersFor(QUESTIONS, ['Svelte', 'lint']), /"Svelte" is not an option of "Which framework\?": React \/ Vue/)
  assert.throws(() => answersFor(QUESTIONS, [['React', 'Vue'], 'lint']), /takes one label/)
  // 1-based option numbers, so a bot never has to put a label on its command line.
  assert.deepEqual(answersFor(QUESTIONS, [2, [1, 2]]), { 'Which framework?': 'Vue', 'Which checks?': 'lint, test' })
  assert.throws(() => answersFor(QUESTIONS, [3, 1]), /has options 1 to 2, not 3/)
  assert.throws(() => answersFor(QUESTIONS, [1.5, 1]), /not 1.5/)
})

test('a hostile label never reaches a command line: the reply takes option numbers, the answer keeps the label as text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-helm-ask-'))
  const label = `x"; echo pwned > pwned.txt; "$(whoami)' & echo pwned > pwned.txt`
  const questions = [{ question: 'Ship?', multiSelect: false, options: [{ label }, { label: 'no' }] }]
  const until = new Date(Date.now() + 60_000).toISOString()
  saveJson(askFile(dir, 'Q00000001'), { id: 'Q00000001', workspaceId: 'w', questions, until, pid: process.pid })
  const payload = questionPayload({ id: 'Q00000001', questions, until }, { repo: 'shop' })
  assert.equal(payload.reply, "orca-helm answer Q00000001 --answers '[<option number>]' --by <who>")
  // The way a bot runs it: no shell between it and node.
  const bin = fileURLToPath(new URL('../bin/orca-helm.mjs', import.meta.url))
  const out = execFileSync(process.execPath, [bin, 'answer', 'Q00000001', '--answers', '[1]', '--by', 'shin', '--json'], {
    cwd: dir,
    env: { ...process.env, ORCA_HELM_ASK_DIR: dir },
    shell: false,
    encoding: 'utf8',
  })
  assert.deepEqual(JSON.parse(out).answers, { 'Ship?': label })
  assert.equal(fs.existsSync(path.join(dir, 'pwned.txt')), false)
  fs.rmSync(dir, { recursive: true, force: true })
})

test("answer refuses a card whose hook was killed: its file outlives it, but nobody would read the answer", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-helm-ask-'))
  const until = new Date(Date.now() + 60_000).toISOString()
  const dead = spawnSync(process.execPath, ['-e', '']).pid
  saveJson(askFile(dir, 'Q00000002'), { id: 'Q00000002', workspaceId: 'w', questions: QUESTIONS.slice(0, 1), until, pid: dead })
  const refused = await answer(dir, ['Q00000002', '--answers', '[1]', '--by', 'shin'])
  assert.equal(refused.code, 1)
  assert.match(refused.stderr, /is not open/)
  assert.equal(fs.existsSync(askFile(dir, 'Q00000002', 'answer')), false)
  fs.rmSync(dir, { recursive: true, force: true })
})

/** Run the hook with `input` on stdin in an Orca-like env; resolves { code, stdout } when it exits. */
function runHook(dir, input, env = {}) {
  const child = spawn(process.execPath, [HOOK], {
    env: { ...process.env, ORCA_HELM_ASK_DIR: dir, ORCA_WORKSPACE_ID: 'repo1::C:/w', ORCA_TERMINAL_HANDLE: 'term_1', ...env },
  })
  let stdout = ''
  child.stdout.on('data', (chunk) => (stdout += chunk))
  child.stdin.end(JSON.stringify(input))
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout })))
}

async function answer(dir, argv) {
  const out = path.join(dir, 'answer.out')
  process.env.ORCA_HELM_ASK_DIR = dir
  const stderr = []
  const write = process.stderr.write
  process.stderr.write = (chunk) => stderr.push(String(chunk))
  try {
    const code = await main(parseCommandLine(['answer', ...argv, '--out', out]))
    return { code, stdout: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : '', stderr: stderr.join('') }
  } finally {
    process.stderr.write = write
    delete process.env.ORCA_HELM_ASK_DIR
  }
}

/** The one question file the hook wrote, once it is there. */
async function questionId(dir) {
  for (let i = 0; i < 100; i++) {
    const name = fs.existsSync(dir) && fs.readdirSync(dir).find((file) => /^Q[0-9a-f]{8}\.json$/.test(file))
    if (name) return name.slice(0, 9)
    await delay(50)
  }
  throw new Error('the hook wrote no question')
}

test('ask-hook: a bot takes the card, orca-helm answer validates it, and the hook allows it with the answers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-helm-ask-'))
  const input = { tool_name: 'AskUserQuestion', tool_use_id: 'toolu_1', tool_input: { questions: QUESTIONS } }
  const hook = runHook(dir, input)
  const id = await questionId(dir)
  const question = JSON.parse(fs.readFileSync(askFile(dir, id), 'utf8'))
  assert.equal(question.workspaceId, 'repo1::C:/w')
  assert.equal(question.terminal, 'term_1')
  saveJson(askFile(dir, id, 'sent'), { routes: ['풀로'] })

  const wrong = await answer(dir, [id, '--answers', '["Vue","deploy"]', '--by', 'shin'])
  assert.equal(wrong.code, 1)
  assert.match(wrong.stderr, /"deploy" is not an option/)
  assert.equal(question.pid > 0, true, 'the hook records its pid')
  const ok = await answer(dir, [id, '--answers', '["Vue",["lint","test"]]', '--by', 'shin'])
  assert.equal(ok.code, 0, ok.stderr)
  assert.equal(ok.stdout, `answered ${id}: Vue | lint, test\n`)

  const { stdout } = await hook
  const out = JSON.parse(stdout).hookSpecificOutput
  assert.equal(out.permissionDecision, 'allow')
  assert.deepEqual(out.updatedInput, { questions: QUESTIONS, answers: { 'Which framework?': 'Vue', 'Which checks?': 'lint, test' } })
  assert.match(out.permissionDecisionReason, /by shin/)
  assert.deepEqual(fs.readdirSync(dir).filter((file) => file.startsWith('Q')), [], 'the hook cleans up')
  const late = await answer(dir, [id, '--answer', 'Vue', '--by', 'shin'])
  assert.equal(late.code, 1)
  assert.match(late.stderr, /is not open/)
  fs.rmSync(dir, { recursive: true, force: true })
})

test('ask-hook: no output (the usual card) outside Orca, when no bot takes it, or when no plugin is there to try', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orca-helm-ask-'))
  const input = { tool_name: 'AskUserQuestion', tool_use_id: 'toolu_2', tool_input: { questions: QUESTIONS.slice(0, 1) } }
  assert.deepEqual(await runHook(dir, input, { ORCA_WORKSPACE_ID: '' }), { code: 0, stdout: '' })

  const noBot = runHook(dir, input)
  const id = await questionId(dir)
  saveJson(askFile(dir, id, 'sent'), { routes: [] })
  assert.deepEqual(await noBot, { code: 0, stdout: '' })

  assert.deepEqual(await runHook(dir, input, { ORCA_HELM_ASK_SENT_WAIT: '0.2' }), { code: 0, stdout: '' }, 'no plugin answered')
  assert.deepEqual(fs.readdirSync(dir), [])
  fs.rmSync(dir, { recursive: true, force: true })
})

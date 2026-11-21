// Files that carry a Claude Code question card (AskUserQuestion) between bin/ask-hook.mjs, the grokbot-notify
// plugin and `orca-helm answer`. In ORCA_HELM_ASK_DIR (default ~/.orca-helm/ask), per question ID:
//   <id>.json         the hook: the questions, workspace, terminal, its pid and `until`; removed when the hook ends
//   <id>.sent.json    the plugin: { routes } that got it, [] when no bot takes it (the card then shows at once)
//   <id>.answer.json  orca-helm answer: { answers, by, at }
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const ASK_VERSION = 1

export const askDir = () => process.env.ORCA_HELM_ASK_DIR || path.join(os.homedir(), '.orca-helm', 'ask')

export const isAskId = (id) => /^Q[0-9a-f]{8}$/.test(String(id))

export const askFile = (dir, id, kind) => path.join(dir, `${id}${kind ? `.${kind}` : ''}.json`)

/** Written whole through a rename, so a reader never sees half a file. */
export function saveJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value))
  fs.renameSync(tmp, file)
}

/** The file's JSON, or null when it is missing or not JSON. */
export function loadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** The process runs. A hook Claude Code killed (Esc, exit) never ran its cleanup, so its file outlives it. */
export function isAlive(pid) {
  if (!Number.isInteger(pid)) return true // a file from before the pid was recorded
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

/** Open: the hook is still waiting for it. shortcut: a reused pid reads as alive; `until` still ends it. */
export const isOpen = (question, now = Date.now()) => Boolean(question) && Date.parse(question.until) > now && isAlive(question.pid)

/**
 * AskUserQuestion's `answers` (question text to label, a multi-select's labels joined with ", ") from `given`, one
 * entry per question: a label or a 1-based option number, or an array of them for a multi-select question. A number
 * keeps a model-written label off a bot's shell command line. Throws when a label or number is not an option.
 * shortcut: no free-text "Other" answer, only listed labels; add one if a person needs to type their own.
 */
export function answersFor(questions, given) {
  if (!Array.isArray(given) || given.length !== questions.length) throw new Error(`expected ${questions.length} answer(s), one per question`)
  return Object.fromEntries(
    questions.map((question, i) => {
      const labels = (question.options ?? []).map((option) => option.label)
      const picked = (Array.isArray(given[i]) ? given[i] : [given[i]]).map((pick) => {
        if (typeof pick !== 'number') return pick
        if (!Number.isInteger(pick) || pick < 1 || pick > labels.length) throw new Error(`"${question.question}" has options 1 to ${labels.length}, not ${pick}`)
        return labels[pick - 1]
      })
      if (picked.length === 0 || (!question.multiSelect && picked.length > 1)) {
        throw new Error(`"${question.question}" takes ${question.multiSelect ? 'one or more labels' : 'one label'}`)
      }
      for (const label of picked) {
        if (!labels.includes(label)) throw new Error(`"${label}" is not an option of "${question.question}": ${labels.join(' / ')}`)
      }
      return [question.question, picked.join(', ')]
    })
  )
}

import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { unwrap } from './core.mjs'

const execFileAsync = promisify(execFile)
const EXEC_OPTIONS = { shell: false, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }

function isRunnable(full) {
  const mode = process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK
  try {
    fs.accessSync(full, mode)
    return fs.statSync(full).isFile()
  } catch {
    return false
  }
}

function findOnPath(name) {
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const full = path.join(dir, name)
    if (isRunnable(full)) return full
  }
  return null
}

/** [label, path or null] pairs in lookup order. */
function unixCandidates() {
  const home = os.homedir()
  const onPath = (name) => [`${name} on PATH`, findOnPath(name)]
  const file = (full) => [full, full]
  if (process.platform === 'darwin') {
    return [onPath('orca'), file(path.join(home, '.local', 'bin', 'orca')), file('/usr/local/bin/orca'), file('/opt/homebrew/bin/orca')]
  }
  if (process.platform === 'linux') {
    return [onPath('orca-ide'), onPath('orca'), file(path.join(home, '.local', 'bin', 'orca-ide')), file('/usr/bin/orca-ide')]
  }
  return [onPath('orca')]
}

/**
 * ORCA_HELM_BIN, else the platform install.
 * Windows: orca.exe on PATH (never orca.cmd — cmd.exe mangles quotes), then
 * %LOCALAPPDATA%\Programs\Orca\bin\orca.exe.
 * macOS: orca on PATH, ~/.local/bin/orca, /usr/local/bin/orca, /opt/homebrew/bin/orca.
 * Linux: orca-ide then orca on PATH, ~/.local/bin/orca-ide, /usr/bin/orca-ide.
 */
export function resolveOrcaBin() {
  if (process.env.ORCA_HELM_BIN) return process.env.ORCA_HELM_BIN
  const tried = []
  const check = (label, full) => {
    tried.push(label)
    return full && isRunnable(full) ? full : null
  }

  if (process.platform === 'win32') {
    const exe = check('orca.exe on PATH', findOnPath('orca.exe'))
    if (exe) return exe
    const cmd = check('orca.cmd on PATH', findOnPath('orca.cmd'))
    if (cmd) {
      const sibling = path.join(path.dirname(cmd), 'orca.exe')
      if (isRunnable(sibling)) return sibling
      throw new Error(`found ${cmd} but sibling orca.exe is missing (set ORCA_HELM_BIN)`)
    }
    const local = process.env.LOCALAPPDATA
    const fallback = path.join(local || '%LOCALAPPDATA%', 'Programs', 'Orca', 'bin', 'orca.exe')
    const found = check(fallback, local && fallback)
    if (found) return found
  } else {
    for (const [label, full] of unixCandidates()) {
      const found = check(label, full)
      if (found) return found
    }
  }
  throw new Error(`orca not found (set ORCA_HELM_BIN). Tried: ${tried.join(', ')}`)
}

function helmError(message, extra = {}) {
  return Object.assign(new Error(message), extra)
}

// ENOENT, EACCES, or EINVAL (a .cmd/.bat without a shell): the binary never ran.
function cannotExecute(error, bin) {
  return String(error?.syscall ?? '').startsWith('spawn') ? helmError(`cannot execute ${bin}: ${error.code}`) : null
}

/** { obj, value } from orca's JSON stdout, null when empty. Throws on invalid JSON. */
function parseJson(stdout) {
  const text = String(stdout ?? '').trim()
  if (!text) return null
  const obj = JSON.parse(text)
  return { obj, value: unwrap(obj) }
}

function errorMessage(parsed, stderr, fallback) {
  if (parsed?.obj?.ok === false) {
    const info = parsed.obj.error
    if (typeof info === 'string' && info) return info
    if (info && typeof info === 'object') return info.message || info.code || fallback
  }
  return String(stderr ?? '').trim() || fallback
}

/** A non-zero exit: prefer orca's JSON error, then stderr. `parsed` carries the JSON body. */
function exitError(error, bin) {
  const spawnError = cannotExecute(error, bin)
  if (spawnError) return spawnError
  let parsed = null
  try {
    parsed = parseJson(error.stdout)
  } catch {
    // stdout was not JSON; stderr explains the failure.
  }
  const fallback = `orca exited ${error.code ?? error.signal ?? 1}`
  return helmError(errorMessage(parsed, error.stderr, fallback), { parsed: parsed?.value })
}

export async function runOrca(args, { json = false } = {}) {
  const bin = resolveOrcaBin()
  const argv = json && !args.includes('--json') ? [...args, '--json'] : args
  let stdout
  try {
    ;({ stdout } = await execFileAsync(bin, argv, EXEC_OPTIONS))
  } catch (error) {
    throw exitError(error, bin)
  }
  if (!json) return stdout
  let parsed
  try {
    parsed = parseJson(stdout)
  } catch {
    throw helmError(`invalid JSON from orca: ${String(stdout).trim().slice(0, 200)}`)
  }
  if (!parsed) throw helmError('empty JSON from orca')
  if (parsed.obj?.ok === false) throw helmError(errorMessage(parsed, '', 'orca failed'), { parsed: parsed.value })
  return parsed.value
}

export function runOrcaRaw(args, stdout = process.stdout) {
  const bin = resolveOrcaBin()
  // A promise settles once, so a 'close' after 'error' is ignored. spawn() itself throws EINVAL for .cmd.
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (chunk) => stdout.write(chunk))
    child.stderr.on('data', (chunk) => process.stderr.write(chunk))
    child.on('error', reject)
    child.on('close', (code) => resolve(code ?? 1))
  }).catch((error) => {
    throw cannotExecute(error, bin) ?? error
  })
}

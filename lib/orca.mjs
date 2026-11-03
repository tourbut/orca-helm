import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { unwrap } from './core.mjs'

const MAX_BUFFER = 64 * 1024 * 1024

function pathDirs() {
  return (process.env.PATH || '').split(path.delimiter).filter(Boolean)
}

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
  for (const dir of pathDirs()) {
    const full = path.join(dir, name)
    if (isRunnable(full)) return full
  }
  return null
}

function missingOrca(tried) {
  throw new Error(`orca not found (set ORCA_HELM_BIN). Tried: ${tried.join(', ')}`)
}

function firstHit(tried, label, full) {
  tried.push(label)
  return full && isRunnable(full) ? full : null
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
  const home = os.homedir()
  const fromPath = (name) => firstHit(tried, `${name} on PATH`, findOnPath(name))

  if (process.platform === 'win32') {
    const exe = fromPath('orca.exe')
    if (exe) return exe
    tried.push('orca.cmd on PATH')
    const cmd = findOnPath('orca.cmd')
    if (cmd) {
      const sibling = path.join(path.dirname(cmd), 'orca.exe')
      if (isRunnable(sibling)) return sibling
      throw new Error(`found ${cmd} but sibling orca.exe is missing (set ORCA_HELM_BIN)`)
    }
    const local = process.env.LOCALAPPDATA
    const fallback = local
      ? path.join(local, 'Programs', 'Orca', 'bin', 'orca.exe')
      : '%LOCALAPPDATA%\\Programs\\Orca\\bin\\orca.exe'
    const found = local ? firstHit(tried, fallback, fallback) : null
    if (!local) tried.push(fallback)
    if (found) return found
    return missingOrca(tried)
  }

  if (process.platform === 'darwin') {
    const onPath = fromPath('orca')
    if (onPath) return onPath
    for (const full of [path.join(home, '.local', 'bin', 'orca'), '/usr/local/bin/orca', '/opt/homebrew/bin/orca']) {
      const found = firstHit(tried, full, full)
      if (found) return found
    }
    return missingOrca(tried)
  }

  if (process.platform === 'linux') {
    const ide = fromPath('orca-ide')
    if (ide) return ide
    const orca = fromPath('orca')
    if (orca) return orca
    for (const full of [path.join(home, '.local', 'bin', 'orca-ide'), '/usr/bin/orca-ide']) {
      const found = firstHit(tried, full, full)
      if (found) return found
    }
    return missingOrca(tried)
  }

  const orca = fromPath('orca')
  if (orca) return orca
  return missingOrca(tried)
}

function execFileAsync(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, {
      shell: false,
      windowsHide: true,
      maxBuffer: MAX_BUFFER,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout
        error.stderr = stderr
        reject(error)
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

function parseStdout(stdout) {
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
  const text = String(stderr ?? '').trim()
  return text || fallback
}

function helmError(message, extra = {}) {
  return Object.assign(new Error(message), extra, { orcaHelm: true })
}

// ENOENT, EACCES, or EINVAL (a .cmd/.bat without a shell): the binary never ran.
function cannotExecute(error, bin) {
  return String(error?.syscall ?? '').startsWith('spawn') ? helmError(`cannot execute ${bin}: ${error.code}`) : null
}

export async function runOrca(args, { json = false } = {}) {
  const bin = resolveOrcaBin()
  const argv = json && !args.includes('--json') ? [...args, '--json'] : [...args]
  try {
    const { stdout } = await execFileAsync(bin, argv)
    if (!json) return stdout
    let parsed
    try {
      parsed = parseStdout(stdout)
    } catch {
      throw helmError(`invalid JSON from orca: ${String(stdout).trim().slice(0, 200)}`)
    }
    if (!parsed) throw helmError('empty JSON from orca')
    if (parsed.obj?.ok === false) throw helmError(errorMessage(parsed, '', 'orca failed'), { parsed: parsed.value })
    return parsed.value
  } catch (error) {
    if (error?.orcaHelm) throw error
    const spawnError = cannotExecute(error, bin)
    if (spawnError) throw spawnError
    let parsed = null
    try {
      parsed = parseStdout(error.stdout)
    } catch {
      parsed = null
    }
    const fallback = `orca exited ${error.status ?? error.code ?? 1}`
    throw helmError(errorMessage(parsed, error.stderr, fallback), { parsed: parsed?.value, stdout: error.stdout, stderr: error.stderr })
  }
}

export function readTextFile(filePath) {
  let text
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch (error) {
    throw new Error(`cannot read ${filePath}: ${error.message}`)
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
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

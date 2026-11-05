import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
// Decision records this orca-helm reads (FullOps docs/events.md). A missing version is a record from before it: 1.
export const DECISION_VERSION = 1

/** Exit 4: FullOps is not there, too old, or speaks another format version. */
export function fullopsError(message) {
  return Object.assign(new Error(message), { exitCode: 4 })
}

/** A repo or worktree set up for FullOps. */
export function isFullOpsRepo(dir) {
  return Boolean(dir) && fs.existsSync(path.join(dir, '.fullops-squad', 'fullops.json'))
}

/** The `- coordinator 역할: \`<role>\`` line under `## 라우팅 기준` in orca-agents.md (FullOps jev_route.marked_role). */
function markedCoordinator(dir) {
  let text
  try {
    text = fs.readFileSync(path.join(dir, '.fullops-squad', 'orca-agents.md'), 'utf8').replace(/\r\n/g, '\n')
  } catch {
    return null
  }
  const section = /^## 라우팅 기준\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(text)?.[1] ?? ''
  return /^- coordinator 역할: `([a-z][a-z0-9_-]*)`/m.exec(section)?.[1] ?? null
}

/**
 * Whether the worktree at `dir` on `branch` is a FullOps worker, by FullOps's own rule (policy.identity): its branch
 * is a role branch from fullops.json `roles`, and that role is not the coordinator's. The coordinator may run in any
 * worktree, a `fullops/coor` one included; a branch with no role is never a worker.
 */
export function isFullOpsWorker(dir, branch) {
  let config
  try {
    config = JSON.parse(fs.readFileSync(path.join(dir, '.fullops-squad', 'fullops.json'), 'utf8'))
  } catch {
    return false
  }
  const name = String(branch ?? '').replace(/^refs\/heads\//, '')
  const role = Object.entries(config?.roles ?? {}).find(([, roleBranch]) => roleBranch === name)?.[0]
  if (!role) return false
  if ((config.mode ?? 'coor') === 'coor') return role !== (config.primary_role || markedCoordinator(dir))
  return name !== config.primary_branch && role !== config.primary_role
}

const versionOf = (name) => (/^\d+(\.\d+)*$/.test(name) ? name.split('.').map(Number) : null)
const newer = (a, b) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  return false
}

/** ORCA_HELM_FULLOPS (the plugin folder, its scripts folder, or decision.py), else the newest Claude Code or Codex install. */
function decisionScript() {
  const env = process.env.ORCA_HELM_FULLOPS
  if (env) return [env, path.join(env, 'decision.py'), path.join(env, 'scripts', 'decision.py')].find((p) => fs.existsSync(p) && fs.statSync(p).isFile())
  let best = null
  for (const tool of ['.claude', '.codex']) {
    const root = path.join(os.homedir(), tool, 'plugins', 'cache', 'fullops-squad', 'fullops-squad')
    let names = []
    try {
      names = fs.readdirSync(root)
    } catch {
      continue
    }
    for (const name of names) {
      const version = versionOf(name)
      const script = path.join(root, name, 'scripts', 'decision.py')
      if (version && (!best || newer(version, best.version)) && fs.existsSync(script)) best = { version, script }
    }
  }
  return best?.script
}

/** decision.py that checks SHA, expiry and responders on answer (FullOps 1.16.0+). */
export function requireDecisionScript() {
  const script = decisionScript()
  if (!script) throw fullopsError('FullOps decision.py not found (install FullOps 1.16.0+ or set ORCA_HELM_FULLOPS)')
  // shortcut: a feature check on the source, until FullOps prints its own version.
  if (!fs.readFileSync(script, 'utf8').includes("'--via'")) throw fullopsError(`${script} is older than FullOps 1.16.0; update FullOps`)
  return script
}

/** Every record must be in the format this orca-helm reads. */
export function checkVersion(item) {
  const version = item?.version ?? 1
  if (version !== DECISION_VERSION) {
    throw fullopsError(`FullOps decision ${item?.id ?? '?'} is format version ${version}; this orca-helm reads ${DECISION_VERSION}. Update orca-helm`)
  }
  return item
}

/** Run decision.py in `repoPath` and return its JSON. A refusal (SHA, expiry, responder) is exit 1 with FullOps's reason. */
export async function runDecision(repoPath, args) {
  const script = requireDecisionScript()
  const python = process.env.ORCA_HELM_PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
  // decision.py prints UTF-8 JSON; Windows Python would otherwise use the console code page.
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
  let stdout
  try {
    ;({ stdout } = await execFileAsync(python, [script, ...args, `--repo=${repoPath}`], { env, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }))
  } catch (error) {
    if (String(error?.syscall ?? '').startsWith('spawn')) throw fullopsError(`cannot run ${python} (${error.code}); set ORCA_HELM_PYTHON`)
    const lines = String(error.stderr ?? '').trim().split(/\r?\n/)
    // argparse ends with `decision.py: error: <reason>`.
    const reason = lines.at(-1)?.replace(/^.*?: error: /, '') || `decision.py exited ${error.code}`
    throw Object.assign(new Error(reason), { exitCode: 1 })
  }
  try {
    return JSON.parse(stdout)
  } catch {
    throw fullopsError(`decision.py printed no JSON: ${String(stdout).trim().slice(0, 200)}`)
  }
}

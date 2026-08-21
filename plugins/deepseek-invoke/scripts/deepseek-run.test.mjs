// deepseek-run.test.mjs: the wrapper's contract.
//
// Offline only -- these must never spend a token, so everything is asserted
// through --dry-run, which composes the run artifacts and exits before
// launching a delegate. RUN_CMD drives the bash original (default) or the Node
// port.
//
// stdin is /dev/null throughout. The wrapper reads a brief from stdin when it
// is not a tty and no -f/positional was given; an open, never-written pipe
// would hang the suite rather than fail it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const RUN = process.env.RUN_CMD ?? `node ${join(import.meta.dirname, 'deepseek-run.mjs')}`

export function runWrapper (args) {
  return new Promise((resolve) => {
    const [cmd, ...pre] = RUN.split(' ')
    const p = spawn(cmd, [...pre, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    p.stdout.on('data', (d) => { stdout += d })
    p.stderr.on('data', (d) => { stderr += d })
    p.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

// A git worktree, because the wrapper keys its per-repo behaviour on the git
// toplevel's basename and falls back to $dir when there is no repo.
const ws = mkdtempSync(join(tmpdir(), 'ws-'))
execFileSync('git', ['-C', ws, 'init', '-q'])
const FROZEN = join(ws, 'tests', 'test_c.py')
execFileSync('mkdir', ['-p', join(ws, 'tests')])
writeFileSync(FROZEN, '')

const dryDir = () => mkdtempSync(join(tmpdir(), 'dry-'))
const has = (dir, needle, ...names) => {
  for (const n of names) {
    const f = join(dir, n)
    if (existsSync(f) && readFileSync(f, 'utf8').includes(needle)) return true
  }
  return false
}

const ALLOW = 'uv run --with pytest python -m pytest'
let composed

test('dry-run composes the run artifacts and exits 0', async () => {
  composed = dryDir()
  const r = await runWrapper([
    '-C', ws, '-m', 'flash', '--frozen', FROZEN, '--allow-test', ALLOW,
    '--dry-run', '--dry-run-dir', composed, 'do the thing',
  ])
  assert.equal(r.code, 0, `dry-run exits 0 (stderr: ${r.stderr.slice(0, 400)})`)
  const files = readdirSync(composed)
  assert.ok(files.some((x) => x.endsWith('.yml')), 'wrote a patch overlay')
  assert.ok(files.includes('hooks.json'), 'wrote hooks.json')
})

test('the patch carries every per-run choice', () => {
  assert.ok(has(composed, 'deepseek-v4-flash', 'patch.yml'), 'selects the requested model')
  assert.ok(has(composed, ws, 'patch.yml'), 'pins the workspace root')
  assert.ok(has(composed, 'dsh-hooks-claude-code', 'patch.yml'), 'mounts the hook bridge')
  assert.ok(has(composed, 'workspace-write', 'patch.yml'), 'sets the permission mode')
})

test('the guard is INSIDE the run dir and executable', () => {
  // Measured 2026-08-15: a guard outside the sandboxed workspace exits 127,
  // and a non-2 exit is a NON-BLOCKING error -- every call is allowed and the
  // run only LOOKS guarded. Accept either implementation's filename.
  const guard = ['delegation-guard.sh', 'delegation-guard.mjs']
    .map((n) => join(composed, n)).find(existsSync)
  assert.ok(guard, 'guard is inside the run dir')
  assert.ok(statSync(guard).mode & 0o111, 'and is executable')
  assert.ok(has(composed, 'delegation-guard', 'hooks.json'), 'hooks.json names the guard')
})

test('the policy records what will actually be enforced', () => {
  // guard-env.sh (bash, sourced) or policy.json (Node) -- the recorded CONTENT
  // is the contract, not the file format.
  assert.ok(has(composed, FROZEN, 'guard-env.sh', 'policy.json'), 'frozen path recorded')
  assert.ok(has(composed, 'pytest', 'guard-env.sh', 'policy.json'), 'allow-cmd recorded')
})

test('-m pro reaches the patch too', async () => {
  const d = dryDir()
  await runWrapper(['-C', ws, '-m', 'pro', '--dry-run', '--dry-run-dir', d, 'x'])
  assert.ok(has(d, 'deepseek-v4-pro', 'patch.yml'), 'pro selects deepseek-v4-pro')
})

test('default backend is dsh', async () => {
  const r = await runWrapper(['-C', ws, '--dry-run', '--dry-run-dir', dryDir(), 'x'])
  assert.match(r.stderr, /backend: dsh/, 'announces the dsh backend')
})

test('claude-code backend is still selectable', async () => {
  const r = await runWrapper(['-C', ws, '--backend', 'claude-code', '--dry-run', '--dry-run-dir', dryDir(), 'x'])
  assert.match(r.stderr, /backend: claude-code/, 'announces the claude-code backend')
})

test('rejects an unknown backend', async () => {
  assert.equal((await runWrapper(['-C', ws, '--backend', 'nope', 'x'])).code, 2)
})

test('no brief is a usage error', async () => {
  assert.equal((await runWrapper(['-C', ws, '--dry-run', '--dry-run-dir', dryDir()])).code, 2)
})

// --------------------------------------------------------------------------
// The approval gate and --no-overlay.
//
// A repo whose overlay has NEVER been approved on this machine: mkdtemp gives a
// path no approvals.json can already carry, so these do not depend on what the
// operator has approved, and none of them records an approval.
// --------------------------------------------------------------------------
const ovWs = mkdtempSync(join(tmpdir(), 'ov-'))
execFileSync('git', ['-C', ovWs, 'init', '-q'])
execFileSync('mkdir', ['-p', join(ovWs, '.deepseek')])
writeFileSync(join(ovWs, '.deepseek', 'overlay.yml'),
  "- insert:\n    - id: lsp\n      name: '@deepseek-ai/dsh-lsp'\n")

test('an unapproved overlay refuses a normal run', async () => {
  const r = await runWrapper(['-C', ovWs, '--dry-run', '--dry-run-dir', dryDir(), 'x'])
  assert.equal(r.code, 2, 'capability never arrives silently with a clone')
  assert.match(r.stderr, /REFUSED/)
})

// 2026-08-20: it did. Editing a repo's overlay re-arms the gate, and the next
// prose delegation -- which mounts nothing from that overlay -- was refused
// until someone approved a language server it would never load. That blocks the
// exact path the docs recommend for markdown work, and the gate buys nothing
// here: --no-overlay grants no capability, so there is none to consent to.
test('--no-overlay does not consult the approval gate', async () => {
  const r = await runWrapper(['-C', ovWs, '--no-overlay', '--dry-run', '--dry-run-dir', dryDir(), 'x'])
  assert.doesNotMatch(r.stderr, /REFUSED/, 'an unmounted overlay cannot refuse the run')
  assert.equal(r.code, 0, `--no-overlay runs unrefused (stderr: ${r.stderr.slice(0, 400)})`)
})

// Reporting the skip as "(approved)" would be a lie in the one place an
// operator looks to find out what the run consented to.
test('--no-overlay does not report the overlay as approved', async () => {
  const r = await runWrapper(['-C', ovWs, '--no-overlay', '--dry-run', '--dry-run-dir', dryDir(), 'x'])
  assert.doesNotMatch(r.stderr, /\(approved\)/, 'never claims an approval it did not check')
})

// --approve-overlay is how the gate is satisfied, so it must keep working on an
// overlay that has not been approved yet.
test('--no-overlay does not mount the repo overlay', async () => {
  const d = dryDir()
  await runWrapper(['-C', ovWs, '--no-overlay', '--dry-run', '--dry-run-dir', d, 'x'])
  assert.equal(existsSync(join(d, 'repo-overlay.yml')), false, 'composed no repo overlay')
})

test('-h mentions both backends', async () => {
  const r = await runWrapper(['-h'])
  assert.equal(r.code, 0, '-h exits 0')
  assert.match(r.stdout, /dsh/, '-h mentions dsh')
  assert.match(r.stdout, /claude-code/, '-h mentions claude-code')
})

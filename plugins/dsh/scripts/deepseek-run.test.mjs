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
import { spawnSync } from 'node:child_process'
import { resolveDsh } from './deepseek-run.mjs'

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
    if (!existsSync(f)) continue
    const text = readFileSync(f, 'utf8')
    if (text.includes(needle)) return true
    // A raw substring search is format-BLIND, and policy.json is JSON: a Windows
    // path's separators are stored escaped, so the unescaped needle never
    // matches. A POSIX path contains no character JSON escapes, which is why
    // this silently worked everywhere except the platform the port is for.
    // Compare against the encoded form too (quotes stripped).
    if (n.endsWith('.json') && text.includes(JSON.stringify(needle).slice(1, -1))) return true
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
  assert.ok(has(composed, 'deepseek-flash', 'patch.yml'), 'selects the requested model')
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
  // The .sh original was exec'd directly, so its mode bit was the thing. The
  // Node guard is always invoked as `node "<path>"` -- gen-hooks names the
  // interpreter because PowerShell cannot run a bare shebang script -- so the
  // mode bit is vestigial for it, and NTFS has no exec bit to report anyway
  // (mode & 0o111 is 0 for every file). Assert what actually has to hold:
  // that the runtime can load the deployed copy.
  if (guard.endsWith('.sh')) {
    assert.ok(statSync(guard).mode & 0o111, 'the shell guard is executable')
  } else {
    assert.equal(spawnSync(process.execPath, ['--check', guard]).status, 0,
      'node can load the deployed guard')
  }
  assert.ok(has(composed, 'delegation-guard', 'hooks.json'), 'hooks.json names the guard')
})

test('the policy records what will actually be enforced', () => {
  // guard-env.sh (bash, sourced) or policy.json (Node) -- the recorded CONTENT
  // is the contract, not the file format.
  assert.ok(has(composed, FROZEN, 'guard-env.sh', 'policy.json'), 'frozen path recorded')
  assert.ok(has(composed, 'pytest', 'guard-env.sh', 'policy.json'), 'allow-cmd recorded')
})

// deepseek-flash is the only model. These three cases are the contract: the
// default needs no flag, `-m flash` still works because callers and dsh-doctor
// pass it, and any other value is REFUSED rather than quietly remapped -- a run
// that ignored `-m pro` and reported success is the silent acceptance this
// project treats as the house failure mode.
test('the default model needs no flag and is flash', async () => {
  const d = dryDir()
  await runWrapper(['-C', ws, '--dry-run', '--dry-run-dir', d, 'x'])
  assert.ok(has(d, 'deepseek-flash', 'patch.yml'), 'defaults to deepseek-flash')
})

test('-m flash is still accepted', async () => {
  const d = dryDir()
  const r = await runWrapper(['-C', ws, '-m', 'flash', '--dry-run', '--dry-run-dir', d, 'x'])
  assert.equal(r.code, 0, `-m flash exits 0 (stderr: ${r.stderr.slice(0, 400)})`)
  assert.ok(has(d, 'deepseek-flash', 'patch.yml'), 'writes deepseek-flash')
})

test('-m pro is refused loudly, not remapped', async () => {
  const d = dryDir()
  const r = await runWrapper(['-C', ws, '-m', 'pro', '--dry-run', '--dry-run-dir', d, 'x'])
  // Exit 2 specifically: a caller treating a non-2 exit as "carry on" is the
  // fail-open this wrapper exits 2 everywhere to avoid.
  assert.equal(r.code, 2, `-m pro exits 2 (stderr: ${r.stderr.slice(0, 400)})`)
  assert.match(r.stderr, /only 'flash' is supported/, 'names the one supported model')
  assert.match(r.stderr, /2026-09-14/, 'names the retirement date')
  // And it composed NOTHING -- a refusal that still wrote a patch would leave a
  // pro-shaped artifact on disk for a later run to pick up.
  assert.ok(!has(d, 'deepseek-v4-pro', 'patch.yml'), 'wrote no pro patch')
  assert.ok(!has(d, 'deepseek-flash', 'patch.yml'), 'did not silently remap to flash')
})

test('a legacy model id is refused as well', async () => {
  const r = await runWrapper(['-C', ws, '-m', 'deepseek-v4-flash', '--dry-run', '--dry-run-dir', dryDir(), 'x'])
  assert.equal(r.code, 2, 'a legacy alias is not a pass-through')
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

// Measured 2026-08-20: npm installs the global bin as `dsh`/`dsh.cmd`/`dsh.ps1`
// with no `dsh.exe`, and Node does no PATHEXT resolution without `shell: true`,
// so `spawnSync('dsh', ...)` was ENOENT on Windows and the dsh backend could not
// launch at all. The invariant is not "which name" -- it is that whatever
// resolveDsh hands back is spawnable WITHOUT a shell, because the brief travels
// as one argv element full of `&&`, `|` and backticks that cmd.exe would eat.
test('resolveDsh returns something spawnable without a shell', (t) => {
  const d = resolveDsh()
  const probe = spawnSync(d.cmd, [...d.pre, '--version'], { stdio: 'pipe', encoding: 'utf8' })
  if (probe.error && d.cmd === 'dsh') {
    t.skip('dsh is not installed on this machine')
    return
  }
  assert.equal(probe.error, undefined, `spawned with no shell (cmd: ${d.cmd})`)
  assert.equal(probe.status, 0, 'dsh --version exits 0')
  assert.match(probe.stdout, /[0-9]+[.][0-9]+[.][0-9]+/, 'reports a version')
})

// The POSIX shim is a real executable, so resolution there must stay a no-op --
// a Windows fix that changed Linux behaviour would be a regression nobody on
// Linux asked for.
test('resolveDsh is a no-op off win32', () => {
  assert.deepEqual(resolveDsh({ PATH: '/nonexistent' }, 'linux'), { cmd: 'dsh', pre: [] })
})

// The fallback keeps the existing not-installed message reachable: an operator
// with no dsh must still be told how to install it, not handed an ENOENT trace.
test('resolveDsh falls back to the bare name when nothing resolves', () => {
  assert.deepEqual(resolveDsh({ PATH: '' }, 'win32'), { cmd: 'dsh', pre: [] })
})

// Measured 2026-08-20 on Windows: `workspaceRoot: "${r.dir}"` put a backslash
// path inside a DOUBLE-quoted YAML scalar, where a backslash opens an escape.
// dsh died in composeProfile with "expected hexadecimal character" before the
// delegate ever started. Plain (unquoted) survives backslashes but not a path
// containing " #" or ": "; single-quoted survives both.
const BACKSLASH = String.fromCharCode(92)
const PATH_KEYS = ["workspaceRoot:", "configPath:", "projectDir:"]

test('generated patch.yml quotes paths so a backslash cannot open an escape', async () => {
  const d = dryDir()
  await runWrapper(['-C', ws, '--frozen', 'tests/test_c.py', '--dry-run', '--dry-run-dir', d, 'x'])
  const lines = readFileSync(join(d, 'patch.yml'), 'utf8').split(String.fromCharCode(10))

  const paths = lines.filter((l) => PATH_KEYS.some((k) => l.trim().startsWith(k)))
  assert.equal(paths.length, 3, 'all three interpolated paths are present')
  for (const l of paths) {
    const value = l.slice(l.indexOf(':') + 1).trim()
    assert.ok(value.startsWith("'") && value.endsWith("'"), `single-quoted: ${l.trim()}`)
  }

  // The class, not just the instance: no double-quoted scalar anywhere in the
  // generated patch may carry a backslash.
  for (const l of lines) {
    const i = l.indexOf(': "')
    if (i === -1) continue
    assert.ok(!l.slice(i).includes(BACKSLASH), `double-quoted scalar with a backslash: ${l.trim()}`)
  }
})

// --------------------------------------------------------------------------
// Values that begin with a dash.
//
// 2026-08-21: the natural way to deny pytest's integration marker --
// `- "-m integration"` in a repo's policy.yml -- reached gen-hooks as
// `--deny-cmd -m integration`, which node:util parseArgs refuses. The run died
// with "could not generate the guard" and named the wrong culprit, so a
// legitimate rule was simply unexpressible. Fixed by passing every
// caller-supplied value as `--opt=value`.
// --------------------------------------------------------------------------
const dashWs = mkdtempSync(join(tmpdir(), 'dash-'))
execFileSync('mkdir', ['-p', join(dashWs, '.deepseek')])
writeFileSync(join(dashWs, '.deepseek', 'policy.yml'),
  'denyCmd:\n  - "-m integration"\ndenyPath:\n  - "-weird-dir/**"\n')

test('a deny entry starting with a dash composes instead of aborting', async () => {
  const d = dryDir()
  const r = await runWrapper(['-C', dashWs, '--dry-run', '--dry-run-dir', d, 'x'])
  assert.equal(r.code, 0, `the run composes (stderr: ${r.stderr.slice(0, 400)})`)

  const pol = JSON.parse(readFileSync(join(d, 'policy.json'), 'utf8'))
  assert.ok(pol.denyCmd.includes('-m integration'), 'the dash-prefixed command deny reached the guard')
  assert.ok(pol.denyPath.includes('-weird-dir/**'), 'the dash-prefixed path deny reached the guard')
})

// The same hazard on the operator's own flags, which are free text by design.
test('a frozen path and an allowed command starting with a dash survive', async () => {
  const d = dryDir()
  const r = await runWrapper([
    '-C', ws, '--frozen', '-odd-name.py', '--allow-test', '-m pytest',
    '--dry-run', '--dry-run-dir', d, 'x',
  ])
  assert.equal(r.code, 0, `composes (stderr: ${r.stderr.slice(0, 400)})`)
  const pol = JSON.parse(readFileSync(join(d, 'policy.json'), 'utf8'))
  assert.ok(pol.frozen.includes('-odd-name.py'), 'the frozen path reached the guard')
  assert.equal(pol.allowCmd, '-m pytest', 'the allowed command reached the guard intact')
})

// -e reached NOTHING on the default backend, and the obvious fix did not work.
//
// Measured 2026-09-10 by researching DeepSeek's API docs and then reading this
// file: `effort` was consumed only by runClaudeCode() as
// CLAUDE_CODE_EFFORT_LEVEL, so `-e max` on the default dsh backend was parsed,
// stored and silently dropped -- the run reported success having ignored an
// explicit flag, which is the silent acceptance `-m` refuses one case-label up.
// It hid because the wrapper's default (high) matches the API's, so the
// behaviour was right for anyone who never passed the flag.
//
// The first fix attempt wrote an llm-deepseek patch row carrying
// reasoningEffort. It composed perfectly -- `dsh --patch ... --dump-config`
// showed it applied -- and changed nothing: three live runs at off, max and max
// logged the identical request header (reasoningEffort "high"). The agent takes
// its effort from the agent-default-model SETTINGS section, a per-machine file
// that --patch cannot reach. That row was removed rather than kept, because a
// row that dump-config shows as live while the request ignores it is worse than
// no row at all.
//
// So the flag is refused on the backend that cannot honour it. These tests pin
// the refusal, because "accepted and ignored" is the state we are leaving.
test('-e is refused on the dsh backend rather than silently dropped', async () => {
  const d = dryDir()
  const r = await runWrapper(['-C', ws, '-e', 'max', '--dry-run', '--dry-run-dir', d, 'x'])
  assert.equal(r.code, 2, `-e on the dsh backend exits 2 (stderr: ${r.stderr.slice(0, 400)})`)
  assert.match(r.stderr, /would be ignored|no per-run effort control/, 'says the flag would be ignored')
  assert.match(r.stderr, /claude-code/, 'names the backend that does support it')
})

test('no run composes an llm-deepseek effort row', async () => {
  // The removed fix attempt. If this row ever comes back it must come back with
  // a live run proving the request header actually changes.
  for (const argv of [['-C', ws], ['-C', ws, '--backend', 'claude-code']]) {
    const d = dryDir()
    await runWrapper([...argv, '--dry-run', '--dry-run-dir', d, 'x'])
    assert.ok(!has(d, 'reasoningEffort', 'patch.yml'), 'writes no reasoningEffort row')
  }
})

test('-e is still accepted by the backend that carries it', async () => {
  const r = await runWrapper(['-C', ws, '--backend', 'claude-code', '-e', 'max', '--dry-run', '--dry-run-dir', dryDir(), 'x'])
  assert.equal(r.code, 0, `-e max on claude-code exits 0 (stderr: ${r.stderr.slice(0, 400)})`)
})

test('an unsupported -e value is refused, naming the accepted set', async () => {
  // `none` is the HTTP API's spelling of the lowest setting; the harness plugin
  // spells it `off`. It is the most likely wrong value a reader of DeepSeek's
  // own docs would type, so the refusal names what IS accepted.
  const r = await runWrapper(['-C', ws, '--backend', 'claude-code', '-e', 'none', '--dry-run', '--dry-run-dir', dryDir(), 'x'])
  assert.equal(r.code, 2, `-e none exits 2 (stderr: ${r.stderr.slice(0, 400)})`)
  assert.match(r.stderr, /off\|low\|high\|max/, 'names the accepted values')
})

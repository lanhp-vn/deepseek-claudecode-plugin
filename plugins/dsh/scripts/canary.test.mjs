import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs'
import { spawnSync, execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCanary, PROBE_PATH, hookCommandFrom } from './canary.mjs'

// The guard the canary must probe is the one gen-hooks DEPLOYS into the run
// directory, so every case here stages a copy there -- exactly as production
// does. Probing the source guard instead would read the wrong policy.json (the
// guard resolves it as its own sibling) and would pass while the deployed copy
// was missing.
const GUARD_SRC = process.env.CANARY_GUARD ??
  // NOT `.pathname`: on Windows that yields `/D:/repo/...`, whose leading slash
  // makes copyFileSync resolve it against the cwd and look for `D:\D:\repo\...`.
  // Measured 2026-08-20: all four staging cases died on ENOENT, so the tests for
  // the canary -- the backstop behind every other guarantee here -- did not run
  // on Windows at all.
  fileURLToPath(new URL('../skills/_delegation/scripts/delegation-guard.mjs', import.meta.url))

const stage = (policy, { deployGuard = true } = {}) => {
  const d = mkdtempSync(join(tmpdir(), 'canary-'))
  writeFileSync(join(d, 'policy.json'), JSON.stringify(policy))
  if (deployGuard) copyFileSync(GUARD_SRC, join(d, 'delegation-guard.mjs'))
  return d
}

test('a live guard blocks the canary and reports ok', async () => {
  const d = stage({ frozen: [PROBE_PATH], allowCmd: '', denyPath: [], denyCmd: [], denyTool: [] })
  const r = await runCanary({ guardPath: join(d, 'delegation-guard.mjs'), runDir: d })
  assert.equal(r.ok, true, r.detail)
})

// The failure this whole design exists to catch.
test('a guard that cannot execute reports NOT ok', async () => {
  const d = stage({ frozen: [PROBE_PATH] }, { deployGuard: false })
  const r = await runCanary({ guardPath: join(d, 'does-not-exist.mjs'), runDir: d })
  assert.equal(r.ok, false)
  // Either diagnosis is correct here, and which one fires is platform-dependent.
  // On a fail-CLOSED hook form (Windows) a missing guard blocks everything, so it
  // is the ALLOW probe that catches it; elsewhere the BLOCK probe sees a non-2
  // exit. The contract is `ok === false` with a detail that names the problem.
  assert.match(r.detail, /did not block|must allow|not runnable/i)
})

test('a guard that allows everything reports NOT ok', async () => {
  const d = stage({ frozen: [] })   // nothing frozen -> the probe is allowed
  const r = await runCanary({ guardPath: join(d, 'delegation-guard.mjs'), runDir: d })
  assert.equal(r.ok, false)
  assert.match(r.detail, /UNGUARDED/)
})

// The 2026-08-15 incident in miniature: the guard exists but its policy does
// not, so it can make no decision. That must read as unguarded, not as fine.
//
// CHANGED 2026-08-20, deliberately. This used to assert ok:true, on the grounds
// that a policy-less guard fails closed and a closed boundary is a live one.
// Safe, but not useful: such a guard refuses EVERY tool call, so the run is paid
// for and the delegate can do nothing. The canary's whole promise is "Nothing has
// been spent", so it now runs a second probe for a call that must be ALLOWED and
// reports a guard that cannot discriminate as broken.
test('a guard with no policy.json reports NOT ok', async () => {
  const d = mkdtempSync(join(tmpdir(), 'canary-'))
  copyFileSync(GUARD_SRC, join(d, 'delegation-guard.mjs'))
  const r = await runCanary({ guardPath: join(d, 'delegation-guard.mjs'), runDir: d })
  assert.equal(r.ok, false, 'a guard that can make no decision is not a live boundary')
  assert.match(r.detail, /must allow|not discriminating/i)
})

test('a guard that is not valid JS reports NOT ok', async () => {
  const d = stage({ frozen: [PROBE_PATH] }, { deployGuard: false })
  writeFileSync(join(d, 'delegation-guard.mjs'), 'this is not javascript {{{')
  const r = await runCanary({ guardPath: join(d, 'delegation-guard.mjs'), runDir: d })
  assert.equal(r.ok, false)
})

test('the detail always says what the operator must know', async () => {
  const d = stage({ frozen: [] })
  const r = await runCanary({ guardPath: join(d, 'delegation-guard.mjs'), runDir: d })
  assert.match(r.detail, /exit 0/, 'names the exit code it actually saw')
})

// THE 2026-08-20 FINDING, as a regression test.
//
// A block is only a block if exit 2 survives the shell dsh runs hooks through.
// It did not: PowerShell does not adopt a native command's exit code, so
// `node guard.mjs` exiting 2 left the hook process exiting 1 -- non-blocking --
// and a delegate briefed to edit a frozen test had the edit refused and applied
// anyway. Assert the END-TO-END shape: the command gen-hooks actually generates,
// run through the platform shell, must yield 2 for a blocked call and 0 for an
// allowed one.
test('a block survives the shell the harness runs hooks through', async () => {
  const d = stage({ frozen: [PROBE_PATH] })
  const cmd = hookCommandFrom(d, join(d, 'delegation-guard.mjs'))
  const [sh, pre] = process.platform === 'win32'
    ? ['powershell', ['-NoProfile', '-Command']]
    : ['sh', ['-c']]

  const run = (payload) => spawnSync(sh, [...pre, cmd],
    { cwd: d, input: payload, encoding: 'utf8' }).status

  assert.equal(run(JSON.stringify({ tool_name: 'write', tool_input: { file_path: PROBE_PATH } })), 2,
    'a frozen write must reach the harness as exit 2, or it is not a block')
  assert.equal(run(JSON.stringify({ tool_name: 'write', tool_input: { file_path: '/not/frozen' } })), 0,
    'an allowed write must stay exit 0, or the guard blocks everything')
})

// The canary builds this command itself when hooks.json is absent, so its copy
// and gen-hooks' must not drift -- a drifted fallback is a canary quietly back to
// testing the wrong thing. Compare against the REAL generated artifact.
test('the canary fallback command matches what gen-hooks generates', () => {
  const out = mkdtempSync(join(tmpdir(), 'genhooks-'))
  execFileSync(process.execPath, [
    join(import.meta.dirname, '..', 'skills', '_delegation', 'scripts', 'gen-hooks.mjs'),
    '--out', out, '--allow-cmd', 'node --test',
  ], { stdio: 'ignore' })

  const generated = JSON.parse(readFileSync(join(out, 'hooks.json'), 'utf8'))
    .hooks.PreToolUse[0].hooks[0].command
  const guard = join(out, 'delegation-guard.mjs')

  assert.equal(hookCommandFrom(mkdtempSync(join(tmpdir(), 'empty-')), guard), generated,
    'the fallback and the generator agree on the hook command')
})

// The gap this canary had until 2026-08-21: it probed a frozen path spelled
// with '/', while dsh's write tool sends an absolute path spelled with '\'.
// A guard whose separator normalisation is removed still blocks the old probe
// and allows every real Windows write -- so the canary MUST fail here, or it
// certifies a boundary that is off.
test('a guard that does not normalise separators reports NOT ok', async () => {
  const d = stage({ frozen: [PROBE_PATH], allowCmd: '', denyPath: [], denyCmd: [], denyTool: [] })
  const src = readFileSync(join(d, 'delegation-guard.mjs'), 'utf8')
  const broken = src.replace(/const slash = \(p\) => [^\r\n]+/, "const slash = (p) => String(p ?? '')")
  assert.notEqual(broken, src, 'the normalisation must be present to be removable')
  writeFileSync(join(d, 'delegation-guard.mjs'), broken)

  const r = await runCanary({ guardPath: join(d, 'delegation-guard.mjs'), runDir: d })
  assert.equal(r.ok, false)
  assert.match(r.detail, /backslash|'\\'/i)
})

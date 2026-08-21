import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCanary, PROBE_PATH } from './canary.mjs'

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
  assert.match(r.detail, /did not block/i)
})

test('a guard that allows everything reports NOT ok', async () => {
  const d = stage({ frozen: [] })   // nothing frozen -> the probe is allowed
  const r = await runCanary({ guardPath: join(d, 'delegation-guard.mjs'), runDir: d })
  assert.equal(r.ok, false)
  assert.match(r.detail, /UNGUARDED/)
})

// The 2026-08-15 incident in miniature: the guard exists but its policy does
// not, so it can make no decision. That must read as unguarded, not as fine.
test('a guard with no policy.json reports NOT ok', async () => {
  const d = mkdtempSync(join(tmpdir(), 'canary-'))
  copyFileSync(GUARD_SRC, join(d, 'delegation-guard.mjs'))
  const r = await runCanary({ guardPath: join(d, 'delegation-guard.mjs'), runDir: d })
  // The guard fails closed on an unreadable policy, so it DOES block -- which
  // is the correct outcome and the canary correctly reports the boundary live.
  assert.equal(r.ok, true, 'a guard with no policy still fails closed')
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

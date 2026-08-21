import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir, platform } from 'node:os'
import { join } from 'node:path'
import { scaffoldMachine, mask, findKey } from './setup-deepseek.mjs'

test('scaffolds machine.yml with every documented key, commented and empty', () => {
  const home = mkdtempSync(join(tmpdir(), 'home-'))
  scaffoldMachine(home)
  const f = join(home, '.deepseek', 'machine.yml')
  assert.ok(existsSync(f))
  const t = readFileSync(f, 'utf8')
  for (const k of ['python', 'gitnexus_bin']) assert.match(t, new RegExp(`#\\s*${k}:`))
})

// Re-running setup must never discard what the operator hand-edited in.
test('scaffolding twice does not clobber an existing file', () => {
  const home = mkdtempSync(join(tmpdir(), 'home-'))
  scaffoldMachine(home)
  const f = join(home, '.deepseek', 'machine.yml')
  writeFileSync(f, 'python: /mine\n')
  const r = scaffoldMachine(home)
  assert.equal(r.created, false)
  assert.match(readFileSync(f, 'utf8'), /python: \/mine/)
})

test('the scaffold says never to commit it', () => {
  const home = mkdtempSync(join(tmpdir(), 'home-'))
  scaffoldMachine(home)
  assert.match(readFileSync(join(home, '.deepseek', 'machine.yml'), 'utf8'), /NEVER COMMIT/i)
})

// The scaffold must be parseable by the reader that will consume it -- an
// all-comments file is still a document, and it must read as {}.
test('the scaffold parses as an empty mapping', async () => {
  const { parseFlatYaml } = await import('./yaml-lite.mjs')
  const home = mkdtempSync(join(tmpdir(), 'home-'))
  scaffoldMachine(home)
  assert.deepEqual(parseFlatYaml(readFileSync(join(home, '.deepseek', 'machine.yml'), 'utf8')), {})
})

test('a key is masked, never shown', () => {
  assert.equal(mask('sk-abcdefghijklmnopqrstuvwxyz'), 'sk-abcd...wxyz')
  assert.ok(!mask('sk-abcdefghijklmnopqrstuvwxyz').includes('mnop'))
  assert.match(mask('short'), /^<short:5>$/)
})

test('key discovery prefers the argument over the environment', () => {
  const home = mkdtempSync(join(tmpdir(), 'home-'))
  const r = findKey({ key: 'sk-fromarg' }, { DEEPSEEK_API_KEY: 'sk-fromenv' }, home)
  assert.equal(r.key, 'sk-fromarg')
})

test('key discovery falls back to the environment, then the installed file', () => {
  const home = mkdtempSync(join(tmpdir(), 'home-'))
  assert.equal(findKey({}, { DEEPSEEK_API_KEY: 'sk-fromenv' }, home).key, 'sk-fromenv')
  assert.equal(findKey({}, {}, home).key, '', 'nothing installed -> empty, not a throw')
})

test('machine.yml is created under a 0700 directory', { skip: platform() === 'win32' ? 'no POSIX modes' : false }, () => {
  const home = mkdtempSync(join(tmpdir(), 'home-'))
  scaffoldMachine(home)
  assert.equal(statSync(join(home, '.deepseek')).mode & 0o777, 0o700)
})

// --- the hook bridge -------------------------------------------------------
// Without these two packages in the headless profile, the wrapper's patch.yml
// inserts a hooks-cc row naming a package dsh cannot resolve, and EVERY
// delegation dies at boot. A bare `npm i -g @deepseek-ai/dsh` ships neither,
// so this is the most likely reason a fresh install fails.
import { mkdirSync } from 'node:fs'
import { checkHookBridge, HOOK_BRIDGE, HOOK_BRIDGE_FIX } from './setup-deepseek.mjs'

const profile = (deps) => {
  const d = mkdtempSync(join(tmpdir(), 'dsh-'))
  mkdirSync(join(d, 'profiles', 'headless'), { recursive: true })
  writeFileSync(join(d, 'profiles', 'headless', 'package.json'), JSON.stringify({ dependencies: deps }))
  return d
}

test('a complete profile passes', () => {
  const d = profile(Object.fromEntries(HOOK_BRIDGE.map((p) => [p, '0.0.1'])))
  assert.equal(checkHookBridge(d).ok, true)
})

test('a missing hook bridge is reported BY NAME', () => {
  const r = checkHookBridge(profile({ '@deepseek-ai/dsh-lsp': '0.0.1' }))
  assert.equal(r.ok, false)
  assert.deepEqual(r.missing, [...HOOK_BRIDGE])
})

test('a partial bridge names only what is missing', () => {
  const r = checkHookBridge(profile({ '@deepseek-ai/dsh-hooks-claude-code': '0.0.1-rc.5' }))
  assert.equal(r.ok, false)
  assert.deepEqual(r.missing, ['@deepseek-ai/dsh-hook-protocol'])
})

test('no profile at all is NOT ok -- a fresh dsh install ships neither', () => {
  const r = checkHookBridge(mkdtempSync(join(tmpdir(), 'dsh-')))
  assert.equal(r.ok, false)
  assert.match(r.reason, /no headless profile/)
})

test('the fix is a runnable command naming both packages', () => {
  assert.match(HOOK_BRIDGE_FIX, /^dsh plugin --profile headless add /)
  for (const p of HOOK_BRIDGE) assert.ok(HOOK_BRIDGE_FIX.includes(p))
})

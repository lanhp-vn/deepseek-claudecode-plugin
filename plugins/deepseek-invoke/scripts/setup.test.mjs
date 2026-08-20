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

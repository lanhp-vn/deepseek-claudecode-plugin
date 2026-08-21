import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { discoverSeam, substituteMachine, loadMachine, loadRepoPolicy, MissingMachineKey } from './seam.mjs'

test('finds .deepseek/ at the repo root', () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'))
  mkdirSync(join(repo, '.deepseek'))
  writeFileSync(join(repo, '.deepseek', 'overlay.yml'), '[]')
  const s = discoverSeam(repo)
  assert.equal(s.overlayPath, join(repo, '.deepseek', 'overlay.yml'))
  assert.equal(s.policyPath, null, 'absent policy.yml is null, not an error')
})

test('a repo with no .deepseek/ yields nulls, not an error', () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'))
  assert.deepEqual(discoverSeam(repo), { overlayPath: null, policyPath: null })
})

test('substitutes a machine key', () => {
  assert.equal(substituteMachine('p: ${machine.python}', { python: '/v/bin/python' }), 'p: /v/bin/python')
})

test('substitutes the same key more than once', () => {
  assert.equal(substituteMachine('${machine.p} and ${machine.p}', { p: 'X' }), 'X and X')
})

// Silent acceptance is the house failure mode: a bad model name falls back, a
// bad effort value is ignored, an image becomes placeholder text. Not here.
test('a missing machine key fails by NAME, never silently', () => {
  assert.throws(
    () => substituteMachine('p: ${machine.python}', {}),
    (e) => e instanceof MissingMachineKey && e.message.includes('python') && e.message.includes('machine.yml'),
  )
})

test('an EMPTY machine value is missing, not an empty string', () => {
  assert.throws(() => substituteMachine('p: ${machine.python}', { python: '' }), MissingMachineKey)
  assert.throws(() => substituteMachine('p: ${machine.python}', { python: null }), MissingMachineKey)
})

test('no placeholder literal ever survives substitution', () => {
  const out = substituteMachine('a: ${machine.x}\nb: plain', { x: '1' })
  assert.ok(!out.includes('${machine.'), 'no ${machine. literal remains')
})

test('a MALFORMED placeholder is refused, not passed through', () => {
  assert.throws(() => substituteMachine('a: ${machine.}', { x: '1' }), MissingMachineKey)
})

test('text with no placeholders is returned unchanged', () => {
  const t = '- id: tool-web\n  config:\n    fetch: false\n'
  assert.equal(substituteMachine(t, {}), t)
})

test('loadMachine on an absent file is {}, not a throw', () => {
  assert.deepEqual(loadMachine(mkdtempSync(join(tmpdir(), 'home-'))), {})
})

test('loadMachine reads a flat file', () => {
  const home = mkdtempSync(join(tmpdir(), 'home-'))
  mkdirSync(join(home, '.deepseek'))
  writeFileSync(join(home, '.deepseek', 'machine.yml'), 'python: /v/bin/python\n')
  assert.deepEqual(loadMachine(home), { python: '/v/bin/python' })
})

test('loadRepoPolicy(null) is null', () => {
  assert.equal(loadRepoPolicy(null), null)
})

test('loadRepoPolicy reads deny lists', () => {
  const repo = mkdtempSync(join(tmpdir(), 'repo-'))
  mkdirSync(join(repo, '.deepseek'))
  const p = join(repo, '.deepseek', 'policy.yml')
  writeFileSync(p, 'denyCmd:\n  - make deploy\ndenyPath:\n  - "*.enc"\n')
  assert.deepEqual(loadRepoPolicy(p), { denyCmd: ['make deploy'], denyPath: ['*.enc'] })
})

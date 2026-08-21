// yaml-lite vs a real YAML parser. This is the test that earns the right to
// ship a hand-written reader instead of a dependency: for every document
// yaml-lite ACCEPTS, a real parser must return exactly the same value.
//
// It found two bugs on first run (2026-08-20):
//   * a bare `denyPath:` returned [] here and null there;
//   * a single-quoted 'it''s here' was cut at the escaped quote.
// Both were fixed here, not asserted away.
//
// Skips when PyYAML is unavailable -- it is a correctness cross-check, not a
// prerequisite. Nothing in the plugin imports it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { parseFlatYaml } from './yaml-lite.mjs'

let skip = false
try { execFileSync('python3', ['-c', 'import yaml'], { stdio: 'ignore' }) } catch { skip = 'PyYAML not installed' }

const realYaml = (doc) => JSON.parse(execFileSync('python3',
  ['-c', 'import sys,yaml,json; d=yaml.safe_load(sys.stdin.read()); print(json.dumps(d if d is not None else {}))'],
  { input: doc, encoding: 'utf8' }))

const ACCEPTED = [
  'python: /v/bin/python\nboard: 10.0.0.4\n',
  'denyCmd:\n  - make deploy\n  - "git push --force"\n',
  'denyPath:\n  - "*.enc"\n  - "credentials/**"\n  - ".env*"\n',
  '# top\n\nkey: v  # trailing\n',
  'k: "a # b"\n',
  'denyPath:\ndenyCmd:\n  - "adb * shell reboot"\n',
  "s: 'it''s here'\n",
  'gitnexus.bin: /opt/gitnexus/bin/gitnexus\n',
  'denyTool:\n  - mcp__gitnexus__cypher\n  - cordis_run\n',
]

for (const [i, doc] of ACCEPTED.entries()) {
  test(`accepted doc ${i} parses identically to real YAML`, { skip }, () => {
    assert.deepEqual(parseFlatYaml(doc, 'x.yml'), realYaml(doc))
  })
}

// The converse half: an unquoted glob is a YAML ALIAS, and a real parser
// refuses it outright. Accepting it here would hand back a value the `yaml`
// package would never produce -- which is the divergence this file forbids.
test('an unquoted glob is refused by BOTH', { skip }, () => {
  const doc = 'denyPath:\n  - *.enc\n'
  assert.throws(() => parseFlatYaml(doc, 'policy.yml'))
  assert.throws(() => realYaml(doc), 'real YAML rejects it too')
})

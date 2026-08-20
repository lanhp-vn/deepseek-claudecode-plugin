import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseFlatYaml, YamlLiteError } from './yaml-lite.mjs'

test('reads flat scalars', () => {
  assert.deepEqual(parseFlatYaml('python: /v/bin/python\nboard: 10.0.0.4'),
    { python: '/v/bin/python', board: '10.0.0.4' })
})

test('reads block lists', () => {
  assert.deepEqual(parseFlatYaml('denyCmd:\n  - make deploy\n  - "git push --force"'),
    { denyCmd: ['make deploy', 'git push --force'] })
})

test('a bare key is null, exactly as a real YAML parser returns it', () => {
  assert.deepEqual(parseFlatYaml('denyPath:'), { denyPath: null })
})

test('a key with items under it is a list', () => {
  assert.deepEqual(parseFlatYaml('denyPath:\n  - "a"'), { denyPath: ['a'] })
})

test("single-quoted '' is an escaped quote, not the end of the scalar", () => {
  assert.deepEqual(parseFlatYaml("s: 'it''s here'"), { s: "it's here" })
})

test('ignores comments and blank lines', () => {
  assert.deepEqual(parseFlatYaml('# top\n\nkey: v  # trailing\n'), { key: 'v' })
})

test('quoted values keep their spaces and their #', () => {
  assert.deepEqual(parseFlatYaml('k: "a # b"'), { k: 'a # b' })
})

test('an empty document is an empty object', () => {
  assert.deepEqual(parseFlatYaml(''), {})
  assert.deepEqual(parseFlatYaml('\n# only a comment\n'), {})
})

// The property this file exists for: anything accepted here is accepted by a
// real YAML parser with the same meaning. Everything else is REFUSED by name.
const refused = [
  ['an unquoted glob (YAML would read * as an alias)', 'denyPath:\n  - *.enc'],
  ['an unquoted anchor', 'k: &anchor'],
  ['a flow sequence', 'k: [a, b]'],
  ['a flow mapping', 'k: {a: b}'],
  ['a block scalar', 'k: |'],
  ['a nested mapping', 'a:\n  b: c'],
  ['a tab', 'k:\tv'],
  ['a list item before any key', '  - orphan'],
  ['a duplicate key', 'k: 1\nk: 2'],
  ['an unterminated quote', 'k: "oops'],
  ['a directive', '%YAML 1.2'],
  ['junk', 'this is not yaml'],
]
for (const [name, text] of refused) {
  test(`refuses ${name}`, () => {
    assert.throws(() => parseFlatYaml(text, 'policy.yml'), YamlLiteError)
  })
}

test('every refusal names the file and the line', () => {
  try { parseFlatYaml('ok: 1\ndenyPath:\n  - *.enc', 'policy.yml'); assert.fail('should throw') }
  catch (e) {
    assert.match(e.message, /policy\.yml:3/, 'names file and line')
    assert.match(e.message, /quote it/, 'says how to fix it')
  }
})

// A quoted glob is the supported spelling, and it round-trips.
test('a quoted glob is accepted', () => {
  assert.deepEqual(parseFlatYaml('denyPath:\n  - "*.enc"\n  - "credentials/**"'),
    { denyPath: ['*.enc', 'credentials/**'] })
})

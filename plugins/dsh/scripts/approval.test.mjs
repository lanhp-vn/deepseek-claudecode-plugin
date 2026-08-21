import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashOverlay, isApproved, recordApproval, summarise, approvalStore, refusalMessage } from './approval.mjs'

// A home directory holding a hand-authored machine.yml, WITH comments -- the
// thing a read-modify-write of that file would have destroyed.
const home = () => {
  const d = mkdtempSync(join(tmpdir(), 'home-'))
  return d
}
const store = () => join(mkdtempSync(join(tmpdir(), 'm-')), 'approvals.json')

test('an unapproved overlay is not approved', () => {
  assert.equal(isApproved(store(), '/repo/a', hashOverlay('[]')), false)
})

test('recording an approval makes it approved', () => {
  const f = store()
  const h = hashOverlay('[]')
  recordApproval(f, '/repo/a', h)
  assert.equal(isApproved(f, '/repo/a', h), true)
})

// Editing the overlay must re-arm the gate.
test('a changed overlay is no longer approved', () => {
  const f = store()
  recordApproval(f, '/repo/a', hashOverlay('[]'))
  assert.equal(isApproved(f, '/repo/a', hashOverlay('[changed]')), false)
})

// Two clones of the same project are two decisions.
test('approval is per absolute path, not per basename', () => {
  const f = store()
  const h = hashOverlay('[]')
  recordApproval(f, '/repo/a', h)
  assert.equal(isApproved(f, '/elsewhere/a', h), false)
})

test('approving one repo does not approve another', () => {
  const f = store()
  recordApproval(f, '/repo/a', hashOverlay('[]'))
  recordApproval(f, '/repo/b', hashOverlay('[other]'))
  assert.equal(isApproved(f, '/repo/a', hashOverlay('[]')), true, 'earlier approval survives')
  assert.equal(isApproved(f, '/repo/b', hashOverlay('[other]')), true)
})

// machine.yml is hand-authored and full of comments. Approvals live elsewhere
// precisely so a rewrite can never eat them.
test('recording an approval never touches machine.yml', () => {
  const h = home()
  const machine = join(h, 'machine.yml')
  const original = '# the python this machine uses\npython: /v/bin/python\n'
  writeFileSync(machine, original)
  recordApproval(approvalStore(h), '/repo/a', hashOverlay('[]'))
  assert.equal(readFileSync(machine, 'utf8'), original, 'byte-identical, comments intact')
})

test('the store is created on demand under ~/.deepseek/', () => {
  const h = home()
  const s = approvalStore(h)
  assert.equal(existsSync(s), false)
  recordApproval(s, '/repo/a', hashOverlay('[]'))
  assert.ok(existsSync(s))
})

// A corrupt store must not read as "everything is approved".
test('a corrupt store fails CLOSED', () => {
  const f = store()
  writeFileSync(f, 'not json at all')
  assert.equal(isApproved(f, '/repo/a', hashOverlay('[]')), false)
})

test('the hash is over the raw bytes, so it is machine-independent', () => {
  assert.equal(hashOverlay('p: ${machine.python}'), hashOverlay('p: ${machine.python}'))
  assert.notEqual(hashOverlay('p: ${machine.python}'), hashOverlay('p: /v/bin/python'))
})

test('the summary names what would be mounted', () => {
  const lines = summarise(`
- insert:
    - id: lsp-stdio
      name: '@deepseek-ai/dsh-lsp-stdio'
    - id: mcp-gitnexus
      name: '@deepseek-ai/dsh-mcp-client'
`).join('\n')
  assert.match(lines, /dsh-lsp-stdio/)
  assert.match(lines, /dsh-mcp-client/)
})

test('the summary names every machine value the overlay would pull in', () => {
  const lines = summarise("- insert:\n    - id: lsp\n      name: 'x'\n      config:\n        cmd: ${machine.python}\n").join('\n')
  assert.match(lines, /machine\.python/)
})

test('the refusal says what to do and that nothing was spent', () => {
  const m = refusalMessage({ overlayPath: '/repo/a/.deepseek/overlay.yml', overlayText: '- insert:\n    - id: lsp\n      name: y\n', repoRoot: '/repo/a' })
  assert.match(m, /REFUSED/)
  assert.match(m, /--approve-overlay/)
  assert.match(m, /Nothing has been spent/)
  assert.match(m, /lsp/)
})

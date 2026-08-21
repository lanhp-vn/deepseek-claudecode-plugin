import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// A frozen file and a denied path must be recognised however the delegate
// spells the separator.
//
// Measured 2026-08-21, first live run of dsh-doctor on Windows: dsh's `write`
// tool sends an ABSOLUTE file_path, so a frozen `contract.txt` arrived as
// `C:\...\workspace\contract.txt` and the guard exited 0 -- ALLOW. Every
// matcher here speaks `/`, so `endsWith('/contract.txt')` was false and the
// frozen rule, plus every denyPath rule, were silently off for absolute paths
// on the one platform this port exists for. The 2026-08-20 check passed only
// because that delegate happened to send a relative path.
//
// These cases are written with an explicit backslash constant rather than a
// literal, so nothing in the toolchain can quietly normalise them away before
// the guard sees them -- which would leave a test that cannot fail.
const B = String.fromCharCode(92)

// NOT `.pathname`: on Windows that yields `/D:/repo/...`, and the leading slash
// makes copyFileSync resolve it against the cwd.
const GUARD_SRC = fileURLToPath(new URL('./delegation-guard.mjs', import.meta.url))

const dir = mkdtempSync(join(tmpdir(), 'guard-paths-'))
copyFileSync(GUARD_SRC, join(dir, 'delegation-guard.mjs'))
writeFileSync(join(dir, 'policy.json'), JSON.stringify({
  frozen: ['contract.txt'],
  allowCmd: '',
  denyPath: ['.env*', 'credentials/**'],
  denyCmd: [],
  denyTool: [],
}))

const decide = (tool_name, tool_input) => spawnSync(
  process.execPath, [join(dir, 'delegation-guard.mjs')],
  { input: JSON.stringify({ tool_name, tool_input }), encoding: 'utf8' },
).status

const BLOCK = 2
const ALLOW = 0

test('a frozen file is refused however the path is spelled', () => {
  assert.equal(decide('write', { file_path: `C:${B}Users${B}x${B}ws${B}contract.txt` }), BLOCK, 'Windows absolute path')
  assert.equal(decide('write', { file_path: 'contract.txt' }), BLOCK, 'relative path')
  assert.equal(decide('write', { file_path: '/home/x/ws/contract.txt' }), BLOCK, 'POSIX absolute path')
  assert.equal(decide('edit', { file_path: `C:${B}ws${B}contract.txt` }), BLOCK, 'edit, not just write')
  assert.equal(decide('str_replace_editor', { path: `C:${B}ws${B}contract.txt` }), BLOCK, 'the `path` argument')
})

test('a denied path is refused however the path is spelled', () => {
  assert.equal(decide('read', { file_path: `C:${B}Users${B}x${B}ws${B}.env` }), BLOCK, 'Windows absolute .env')
  assert.equal(decide('read', { file_path: `C:${B}Users${B}x${B}credentials${B}t.json` }), BLOCK, 'Windows absolute credentials/')
  assert.equal(decide('grep', { path: `C:${B}Users${B}x${B}credentials`, pattern: 'token' }), BLOCK, 'grep into a denied directory')
})

// The other half of the canary's lesson: a guard that blocks everything is
// broken, not safe. Normalising must not make ordinary work impossible.
test('an ordinary file is still allowed', () => {
  assert.equal(decide('write', { file_path: `C:${B}Users${B}x${B}ws${B}hello.txt` }), ALLOW)
  assert.equal(decide('read', { file_path: `C:${B}Users${B}x${B}ws${B}notes.md` }), ALLOW)
  assert.equal(decide('write', { file_path: 'src/impl.py' }), ALLOW)
})

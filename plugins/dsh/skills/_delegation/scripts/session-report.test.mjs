import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { sessionLabel, report, findNewestLog } from './session-report.mjs'

// The report's heading names the session directory the log came from.
//
// Measured 2026-08-21, reading dsh-doctor's live-tier output on Windows: the
// heading interpolated `logPath.split('/')`, but a $DSH_HOME log path arrives
// with backslashes and contains no `/` at all -- so the slice was empty and
// every Windows run printed "What the delegate actually did (undefined)".
//
// Cosmetic where the frozen-path fail-open of the same day was not, but the same
// defect CLASS: a path read without being normalised to `/` first. Pinned here
// rather than only fixed, because that class has recurred.
//
// The separator is an explicit constant, as in guard-paths.test.mjs: a literal
// can be normalised away somewhere between an editor and disk, which would leave
// a test that cannot fail.
const B = String.fromCharCode(92)

const WIN = ['C:', 'Users', 'p', '.dsh', 'sessions', 'slug', 'session-abc123', 'session.jsonl.zstd'].join(B)
const POSIX = '/home/u/.dsh/sessions/slug/session-abc123/session.jsonl.zstd'

test('sessionLabel names the session directory whichever separator the path uses', () => {
  assert.equal(sessionLabel(WIN), 'session-abc123')
  assert.equal(sessionLabel(POSIX), 'session-abc123')
})

test('sessionLabel degrades to a readable label rather than "undefined"', () => {
  for (const p of ['session.jsonl.zstd', '', null, undefined]) {
    assert.equal(sessionLabel(p), '(unknown session)', `bad label for ${JSON.stringify(p)}`)
  }
})

/** Everything report() writes to stdout, as one string. report() is synchronous,
 *  so the swap cannot straddle another writer. */
function captureReport (events, logPath) {
  const chunks = []
  const real = process.stdout.write
  process.stdout.write = (s) => { chunks.push(String(s)); return true }
  try { report(events, logPath) } finally { process.stdout.write = real }
  return chunks.join('')
}

test('the report heading identifies the session on a Windows log path', () => {
  const text = captureReport([{ type: 'tool/call', data: { name: 'write', arguments: '{}' } }], WIN)
  const heading = text.split('\n').find((l) => l.includes('What the delegate actually did'))
  assert.ok(heading, 'the report printed no heading')
  assert.ok(!heading.includes('undefined'), `heading lost the session id: ${heading}`)
  assert.match(heading, /session-abc123/)
})

// findNewestLog must match the log file dsh actually writes, and dsh renames it.
//
// Measured 2026-09-10, upgrading the harness CLI 0.1.1-rc.2 -> 0.1.5-rc.2: the
// session log is now written as `session.v3.jsonl.zstd`. findNewestLog compared
// the basename to `session.jsonl.zstd` exactly, so the live doctor run found no
// log for itself and FELL BACK to the newest match on disk -- a healthy run from
// an unrelated project -- then printed that session's tool calls and guard
// decisions under a run they did not belong to. The report claimed "no guard was
// mounted on this run" while the guard had in fact blocked twice.
//
// Only the `session log` check caught it: a stale log is indistinguishable from
// a fresh one by content alone. Matched version-agnostically here because the
// infix is upstream's to move again, and the next rename must not silently
// resurrect the fallback.
const mkSessions = () => mkdtempSync(join(tmpdir(), 'dsh-sessions-'))

/** Write a log file at sessions/<slug>/session-<id>/<name> with an explicit mtime. */
function putLog (root, id, name, mtimeMs) {
  const dir = join(root, 'slug', `session-${id}`)
  mkdirSync(dir, { recursive: true })
  const p = join(dir, name)
  writeFileSync(p, 'x')
  utimesSync(p, mtimeMs / 1000, mtimeMs / 1000)
  return p
}

test('findNewestLog finds the versioned log name dsh 0.1.5 writes', () => {
  const root = mkSessions()
  const p = putLog(root, 'aaa', 'session.v3.jsonl.zstd', 1_000_000_000_000)
  assert.equal(findNewestLog(root), p)
})

test('findNewestLog still finds the legacy unversioned log name', () => {
  const root = mkSessions()
  const p = putLog(root, 'bbb', 'session.jsonl.zstd', 1_000_000_000_000)
  assert.equal(findNewestLog(root), p)
})

test('findNewestLog picks the newest across both log spellings', () => {
  const root = mkSessions()
  putLog(root, 'old', 'session.jsonl.zstd', 1_000_000_000_000)
  const newer = putLog(root, 'new', 'session.v3.jsonl.zstd', 2_000_000_000_000)
  assert.equal(findNewestLog(root), newer)

  const root2 = mkSessions()
  putLog(root2, 'old', 'session.v3.jsonl.zstd', 1_000_000_000_000)
  const newer2 = putLog(root2, 'new', 'session.jsonl.zstd', 2_000_000_000_000)
  assert.equal(findNewestLog(root2), newer2)
})

test('findNewestLog ignores files that merely sit beside a log', () => {
  const root = mkSessions()
  putLog(root, 'ccc', 'session.lock', 2_000_000_000_000)
  putLog(root, 'ccc', 'notes.jsonl.zstd', 2_000_000_000_000)
  assert.equal(findNewestLog(root), null)
})

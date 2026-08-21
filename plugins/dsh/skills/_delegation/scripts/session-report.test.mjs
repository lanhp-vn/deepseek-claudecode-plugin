import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sessionLabel, report } from './session-report.mjs'

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

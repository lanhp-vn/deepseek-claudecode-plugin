#!/usr/bin/env node
// session-report.mjs: turn a dsh session log into an audit of what the delegate
// ACTUALLY did -- tool calls, guard decisions, token spend -- rather than what
// it said it did in its closing message.
//
// Usage: session-report.mjs [<session.jsonl.zstd>|<workspace-dir>]
//   With no argument, or a directory, it finds the newest session log under
//   $DSH_HOME/sessions.
//
// Measured facts this depends on (2026-08-15, dsh 0.1.0-rc.6):
//   * the log is ZSTD-compressed JSON lines, at
//     $DSH_HOME/sessions/<slugified-cwd>/session-<uuid>/session.jsonl.zstd
//   * EVERY payload is nested under .data -- reading .name off the envelope
//     returns undefined, which is a silent wrong answer
//   * tool/call: .data.name, .data.arguments (a JSON *string*)
//   * assistant/message: .data.usage.{inputTokens,outputTokens,cacheReadTokens,reasoningTokens}
//   * hook/result: .data.{decision,exitCode,stderrSummary}
//   * turn/end: .data.reason.kind
//
// WHY NODE'S OWN ZSTD. The bash original shelled out to `zstd` and `jq` and
// degraded to a notice when either was missing. Neither ships on Windows, so on
// the platform this port exists for, the report would ALWAYS have degraded --
// and the guard-health warning below is the backstop behind the canary. Node 24
// decompresses zstd natively, so the report works everywhere with no
// dependency at all.
//
// It degrades rather than failing: an unreadable log prints one notice and
// exits 0, because the delegation itself may have been fine and the caller
// still has the diff. SESSION_FORMAT_VERSION is 0 with no compatibility
// promise, so this WILL break on some future dsh release; breaking loudly here
// must not break the wrapper around it.
import { zstdDecompressSync } from 'node:zlib'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const note = (s) => process.stderr.write(`${s}\n`)
const out = (s) => process.stdout.write(`${s}\n`)

/** Newest session.jsonl.zstd anywhere under sessions/, by mtime. */
export function findNewestLog (sessionsDir) {
  if (!existsSync(sessionsDir)) return null
  const found = []
  const walk = (dir, depth = 0) => {
    if (depth > 4) return
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name)
      if (e.isDirectory()) walk(p, depth + 1)
      else if (e.name === 'session.jsonl.zstd') {
        try { found.push([statSync(p).mtimeMs, p]) } catch { /* raced */ }
      }
    }
  }
  walk(sessionsDir)
  if (!found.length) return null
  found.sort((a, b) => b[0] - a[0])
  return found[0][1]
}

// The zstd magic number, little-endian 0xFD2FB528.
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * Decompress a MULTI-FRAME zstd file.
 *
 * dsh appends one zstd frame per write, so a session log is a concatenation of
 * thousands of frames. `zstd -dc` joins them all; Node's zstdDecompressSync and
 * its stream decompressor BOTH stop after the first. Measured 2026-08-20 on a
 * live log: 199 bytes and one line out of Node, against 1,045,056 bytes and
 * 2,612 lines out of the CLI.
 *
 * That is the worst possible failure for this file: the report would print "no
 * tool calls recorded" for a run that made hundreds, and the guard-health
 * warning below -- the backstop behind the canary -- would never fire. It would
 * read as a clean run rather than as a blind one.
 *
 * So frames are split on the magic number and decoded one at a time. A magic
 * sequence can occur by chance INSIDE compressed data, which would cut a real
 * frame short; that slice then fails to decode, so the end is extended to the
 * next candidate until it succeeds. The algorithm self-corrects and the false
 * boundary is skipped.
 */
export function decompressFrames (buf) {
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf.compare(MAGIC, 0, 4, i, i + 4) === 0) starts.push(i)
  }
  if (!starts.length) return zstdDecompressSync(buf)   // not framed the way we expect

  const parts = []
  let k = 0
  while (k < starts.length) {
    let decoded = null
    let next = k + 1
    for (; next <= starts.length; next++) {
      const end = next < starts.length ? starts[next] : buf.length
      try { decoded = zstdDecompressSync(buf.subarray(starts[k], end)); break } catch { /* false boundary */ }
    }
    if (decoded === null) break        // trailing partial frame: a live log being appended
    parts.push(decoded)
    k = next
  }
  return Buffer.concat(parts)
}

export function readEvents (logPath) {
  const raw = decompressFrames(readFileSync(logPath)).toString('utf8')
  const events = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try { events.push(JSON.parse(line)) } catch { /* a torn final line is normal */ }
  }
  return events
}

export function report (events, logPath) {
  const of = (t) => events.filter((e) => e?.type === t).map((e) => e?.data ?? {})

  out(`===== What the delegate actually did (${logPath.split('/').slice(-2, -1)[0]}) =====`)
  const calls = of('tool/call')
  if (!calls.length) out('  (no tool calls recorded)')
  for (const c of calls) {
    const args = String(c.arguments ?? '').slice(0, 110).replace(/\n/g, ' ')
    out(`  ${c.name ?? '?'}  ${args}`)
  }

  // Guard health FIRST, because a guard that could not execute silently allowed
  // everything. Measured: exitCode 127 -> decision "pass" on every call.
  const hooks = of('hook/result')
  if (hooks.length) {
    out('\n===== Guard decisions =====')
    for (const h of hooks) {
      out(`  ${h.decision ?? '?'} (exit ${h.exitCode})  ${String(h.stderrSummary ?? '').slice(0, 100)}`)
    }
    const broken = hooks.filter((h) => h.exitCode !== 0 && h.exitCode !== 2)
    if (broken.length) {
      out(`\n  *** WARNING: ${broken.length} hook invocation(s) exited with neither 0 nor 2.`)
      out('  *** A non-2 exit is a NON-BLOCKING error: those calls were ALLOWED.')
      out('  *** This run was NOT guarded. Check the guard path is inside the workspace.')
    }
  } else {
    out('\n  (no guard was mounted on this run)')
  }

  out('\n===== Tokens (billed by DeepSeek) =====')
  const usage = of('assistant/message').map((d) => d.usage).filter(Boolean)
  if (!usage.length) out('  (no usage recorded)')
  else {
    const sum = (k) => usage.reduce((a, u) => a + (u[k] ?? 0), 0)
    out(`  input ${sum('inputTokens')}  cache_read ${sum('cacheReadTokens')}  ` +
        `output ${sum('outputTokens')}  reasoning ${sum('reasoningTokens')}  steps ${usage.length}`)
  }

  const ends = of('turn/end')
  if (ends.length) out(`\n  final turn: ${ends[ends.length - 1]?.reason?.kind ?? '?'}`)

  // Background spend the delegate never asked for; real, and it happens on any
  // run where 00-base.yml did not disable it.
  if (events.some((e) => e?.type === 'session/title-llm-request')) {
    out('  note: this run also issued a session-title LLM request (billed)')
  }

  out(`\n  log: ${logPath}`)
}

function main (argv) {
  const arg = argv[0] ?? process.cwd()
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  let log = null
  try { if (statSync(arg).isFile()) log = arg } catch { /* not a file */ }
  log ??= findNewestLog(join(dshHome, 'sessions'))

  if (!log || !existsSync(log)) {
    note(`session-report: no session log found under ${join(dshHome, 'sessions')}; review the diff by hand`)
    return 0
  }
  let events
  try { events = readEvents(log) } catch (e) {
    note(`session-report: ${log} did not decompress (${e.message}); review the diff by hand`)
    return 0
  }
  if (!events.length) {
    note(`session-report: ${log} was empty; review the diff by hand`)
    return 0
  }
  report(events, log)
  return 0
}

if (import.meta.filename === process.argv[1]) process.exit(main(process.argv.slice(2)))

// canary.mjs: turn a fail-OPEN architecture into a fail-CLOSED one.
//
// The harness allows any tool call whose hook exits with something other than
// 2. An unreadable guard, a missing interpreter, a syntax error, a wrong path,
// a policy.json that is not there -- every one of them looks exactly like
// "allowed". Measured 2026-08-15 on Linux: a guard placed outside the sandboxed
// workspace exited 127 and every decision came back `pass`, while hooks.json
// looked perfect. The same thing happened on Windows for EVERY run, because
// dsh executes command hooks through ctx.shell -- PowerShell -- which cannot
// execute the .sh the generator used to emit.
//
// So before spending anything, ask the guard to block something it MUST block.
// If it does not, abort the run.
//
// PROBE THE DEPLOYED GUARD, NOT THE SOURCE ONE. guardPath must be the copy
// gen-hooks wrote INTO the run directory -- the exact file, at the exact path,
// that the harness will invoke. Probing the source guard would pass happily
// while the deployed copy was missing, which is the failure this exists to
// catch. The guard also resolves policy.json as its own sibling, so a probe of
// the source guard reads the wrong policy.
//
// There is deliberately NO flag to skip this.
//
// WHAT THIS DOES NOT PROVE. The probe is a frozen-path WRITE, so it certifies
// the frozen rule and the guard's reachability -- not the command allowlist.
// The two halves fail independently, and one did: measured 2026-08-20, `pwsh`
// was missing from the generated matcher, so every shell call on Windows walked
// past --allow-test while this canary reported the boundary live. Extending the
// probe to a denied COMMAND would close that gap and is the obvious next step
// here; until then hooks-matcher.test.mjs is what holds the matcher and the
// guard's switch together.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// A path no real task touches, added to the frozen list for the probe only.
export const PROBE_PATH = '/canary/__guard_probe__'

const PROBE = JSON.stringify({
  tool_name: 'write',
  tool_input: { file_path: PROBE_PATH },
})

// THE SAME FROZEN FILE, SPELLED THE WAY dsh ACTUALLY SPELLS ONE ON WINDOWS.
//
// Measured 2026-08-21: the guard matched frozen paths with `/` only, so a write
// to `C:\...\contract.txt` -- an absolute path, which is the ONLY kind dsh's
// `write` tool sends -- exited 0 and was allowed, while this canary went on
// reporting the boundary live. Its probe could not see the gap because the
// probe itself was forward-slash-only, so it exercised a spelling production
// never uses. That is the same mistake as spawning the guard directly instead
// of through the shell, in a different coordinate.
//
// Probed on every platform, not just win32: the guard normalises separators
// unconditionally, so this must block everywhere, and a POSIX-only maintainer
// editing the path layer gets the failure on their own machine rather than in
// a Windows user's unguarded run.
const PROBE_BACKSLASH = JSON.stringify({
  tool_name: 'write',
  tool_input: { file_path: `C:${String.fromCharCode(92)}canary${String.fromCharCode(92)}__guard_probe__` },
})

// PROBE THROUGH THE SHELL THE HARNESS WILL USE, NOT `node` DIRECTLY.
//
// This probe used to `spawn(process.execPath, [guardPath])`, which tests the
// guard in isolation and skips the wrapper production actually runs it through.
// Measured 2026-08-20: the guard exited 2 under a direct spawn and 1 under
// PowerShell, because PowerShell does not adopt a native command's exit code --
// so a real Windows run delivered every BLOCK to the harness as an ALLOW while
// this function reported `guard blocked the canary`. A canary that exercises a
// path production does not use certifies nothing.
//
// So run the EXACT command string from the generated hooks.json when it is
// there, through the same shell dsh will use. Only that end-to-end shape can
// catch a code that dies in translation.
const shellFor = (cmd) => (process.platform === 'win32'
  ? ['powershell', ['-NoProfile', '-Command', cmd]]
  : ['sh', ['-c', cmd]])

export function hookCommandFrom (runDir, guardPath) {
  const hj = join(runDir, 'hooks.json')
  if (existsSync(hj)) {
    try {
      const c = JSON.parse(readFileSync(hj, 'utf8'))?.hooks?.PreToolUse?.[0]?.hooks?.[0]?.command
      if (c) return c
    } catch { /* fall through to the built form */ }
  }
  // Fallback must match gen-hooks.mjs `hookCommandFor` exactly; canary.test.mjs
  // asserts the two agree, because a fallback that drifts is a canary that
  // silently goes back to testing the wrong thing.
  return process.platform === 'win32'
    ? `node ${JSON.stringify(guardPath)}; if ($LASTEXITCODE -ne 0) { exit 2 }`
    : `node ${JSON.stringify(guardPath)}`
}

// A call the guard MUST allow: a write to a path that is not frozen. Needed
// because the Windows hook form is fail-CLOSED -- it maps any non-zero guard
// exit to 2 -- so "blocked" alone no longer distinguishes a working guard from
// one that is broken and refusing everything. A guard that cannot run fails the
// ALLOW probe, which is what makes a broken guard detectable before spending.
const ALLOW_PATH = '/canary/__guard_probe_allowed__'

const ALLOW_PROBE = JSON.stringify({
  tool_name: 'write',
  tool_input: { file_path: ALLOW_PATH },
})

function probe ({ guardPath, runDir, payload }) {
  return new Promise((resolve) => {
    let stderr = ''
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }

    let p
    try {
      const [sh, args] = shellFor(hookCommandFrom(runDir, guardPath))
      p = spawn(sh, args, { cwd: runDir, stdio: ['pipe', 'ignore', 'pipe'] })
    } catch (e) {
      return done({ code: null, spawnError: e.code ?? e.message, stderr: '' })
    }
    // Cap what we keep: a guard that fails to parse emits a full stack trace,
    // and burying "this run would be UNGUARDED" under twenty frames of node
    // internals is how an operator skims past the one line that matters.
    p.stderr.on('data', (c) => { if (stderr.length < 400) stderr += c })
    p.on('error', (e) => done({ code: null, spawnError: e.code ?? e.message, stderr }))
    p.on('close', (code) => done({ code, stderr }))
    p.stdin.on('error', () => {})   // a guard that exits before reading stdin -> EPIPE, not a crash
    p.stdin.end(payload)
  })
}

export async function runCanary ({ guardPath, runDir }) {
  const first = (s) => s.trim().split('\n')[0] || '(none)'

  // 1. It must BLOCK what it must block.
  const blocked = await probe({ guardPath, runDir, payload: PROBE })
  if (blocked.spawnError) {
    return { ok: false, detail: `the guard did not block the canary: could not spawn it (${blocked.spawnError})` }
  }
  if (blocked.code !== 2) {
    return {
      ok: false,
      detail:
        `the guard did not block the canary (exit ${blocked.code}). The harness treats any non-2 exit as ` +
        `non-blocking, so this run would be UNGUARDED.\n  first stderr line: ${first(blocked.stderr)}`,
    }
  }

  // 2. It must block that same file spelled with backslashes -- the spelling a
  // real Windows delegate sends, and the one that failed open on 2026-08-21.
  const blockedWin = await probe({ guardPath, runDir, payload: PROBE_BACKSLASH })
  if (blockedWin.spawnError) {
    return { ok: false, detail: `the guard did not block the backslash canary: could not spawn it (${blockedWin.spawnError})` }
  }
  if (blockedWin.code !== 2) {
    return {
      ok: false,
      detail:
        `the guard blocked a frozen path written with '/' but ALLOWED the same file written with '\\' ` +
        `(exit ${blockedWin.code}). dsh sends absolute paths, so on Windows the frozen rule and every ` +
        `denyPath rule would be off for real tool calls while looking correct.\n  first stderr line: ${first(blockedWin.stderr)}`,
    }
  }

  // 3. It must ALLOW what it must allow. A guard that is missing, unparseable or
  // crashing blocks EVERYTHING under the fail-closed Windows form, and would
  // otherwise sail past step 1 while being entirely broken.
  const allowed = await probe({ guardPath, runDir, payload: ALLOW_PROBE })
  if (allowed.spawnError) {
    return { ok: false, detail: `the guard is not runnable: could not spawn it (${allowed.spawnError})` }
  }
  if (allowed.code !== 0) {
    return {
      ok: false,
      detail:
        `the guard blocked a call it must allow (exit ${allowed.code}). It is not discriminating -- ` +
        `most likely missing, unparseable or crashing, in which case it refuses EVERY tool call and ` +
        `the delegate can do nothing.\n  first stderr line: ${first(allowed.stderr)}`,
    }
  }

  return { ok: true, detail: 'guard blocked the canary and allowed a permitted call' }
}

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
import { spawn } from 'node:child_process'

// A path no real task touches, added to the frozen list for the probe only.
export const PROBE_PATH = '/canary/__guard_probe__'

const PROBE = JSON.stringify({
  tool_name: 'write',
  tool_input: { file_path: PROBE_PATH },
})

export function runCanary ({ guardPath, runDir }) {
  return new Promise((resolve) => {
    let stderr = ''
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }

    let p
    try {
      p = spawn(process.execPath, [guardPath], { cwd: runDir, stdio: ['pipe', 'ignore', 'pipe'] })
    } catch (e) {
      return done({ ok: false, detail: `the guard did not block the canary: could not spawn it (${e.code ?? e.message})` })
    }
    p.stderr.on('data', (c) => { stderr += c })
    // A guard that cannot even be spawned is the loudest version of the bug.
    p.on('error', (e) => done({ ok: false, detail: `the guard did not block the canary: could not spawn it (${e.code ?? e.message})` }))
    p.on('close', (code) => {
      if (code === 2) return done({ ok: true, detail: 'guard blocked the canary' })
      done({
        ok: false,
        detail:
          `the guard did not block the canary (exit ${code}). The harness treats any non-2 exit as ` +
          `non-blocking, so this run would be UNGUARDED. ${stderr.trim()}`.trim(),
      })
    })
    p.stdin.on('error', () => {})   // a guard that exits before reading stdin -> EPIPE, not a crash
    p.stdin.end(PROBE)
  })
}

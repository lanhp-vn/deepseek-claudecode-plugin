// hooks-matcher.test.mjs: the matcher and the guard must agree.
//
// A tool absent from the PreToolUse matcher is a tool the hook never runs for,
// so the guard's handling of it is dead code and the rule it enforces is simply
// off -- silently, with the config still looking correct. This pair has drifted
// three times now: `apply_patch` (2026-08-15, Codex rewrote a frozen test
// unopposed), then `pwsh` and `NotebookEdit` (2026-08-20, every pwsh call on
// Windows walked past --allow-test while the canary still reported the boundary
// live, because the canary probes the frozen-write half that `write` matches).
//
// The invariant is cheap to state and would have caught all three.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const GEN = join(import.meta.dirname, 'gen-hooks.mjs')
const GUARD = join(import.meta.dirname, 'delegation-guard.mjs')

const matcherOf = (dir) =>
  JSON.parse(readFileSync(join(dir, 'hooks.json'), 'utf8')).hooks.PreToolUse[0].matcher.split('|')

// Every tool name the guard dispatches on. The guard is one flat script whose
// switches run at top level, so it cannot be imported without executing it --
// read the source instead.
const guardTools = () => {
  const src = readFileSync(GUARD, 'utf8')
  return [...new Set([...src.matchAll(/case '([^']+)'/g)].map((m) => m[1]))]
}

test('the matcher covers every tool the guard dispatches on', () => {
  const out = mkdtempSync(join(tmpdir(), 'hooks-'))
  const frozen = join(out, 'frozen.test.mjs')
  writeFileSync(frozen, '')
  // Maximal config: --deny-path and --deny-cmd are what widen the matcher, so
  // this is the only configuration in which full coverage is expected.
  execFileSync(process.execPath, [GEN, '--out', out, '--frozen', frozen,
    '--allow-cmd', 'node --test', '--deny-path', 'secret', '--deny-cmd', 'curl'],
  { stdio: 'ignore' })

  const matcher = matcherOf(out)
  const missing = guardTools().filter((t) => !matcher.includes(t))
  assert.deepEqual(missing, [],
    `the guard handles these but the hook never fires for them: ${missing.join(', ')}`)
})

// The narrow regression, stated on its own: pwsh is dsh's shell tool on Windows,
// so --allow-test and --deny-cmd are unenforced without it no matter what else
// the matcher contains -- and the base tier is where a plain run lives.
test('the base matcher covers both shell tool names, with no deny flags', () => {
  const out = mkdtempSync(join(tmpdir(), 'hooks-'))
  execFileSync(process.execPath, [GEN, '--out', out, '--allow-cmd', 'node --test'], { stdio: 'ignore' })

  const matcher = matcherOf(out)
  for (const tool of ['bash', 'Bash', 'pwsh']) {
    assert.ok(matcher.includes(tool), `${tool} is matched in the base tier`)
  }
})

#!/usr/bin/env node
// gen-hooks.mjs: compose the hooks.json that mounts delegation-guard.mjs, for
// either delegate dialect.
//
// Usage:
//   gen-hooks.mjs --out <dir> [--frozen <path>]... [--allow-cmd "<cmd>"]
//                 [--deny-path <glob>]... [--deny-cmd <pattern>]...
//                 [--deny-tool <name>]... [--dialect dsh|codex]
//
// --deny-path, --deny-cmd and --deny-tool are OPTIONAL and additive. Passing
// none produces the matcher this always had, so existing callers are
// unaffected. Passing --deny-path WIDENS the matcher to include the read and
// search tools, because a secret is leaked by reading it, not by writing it;
// passing either of the first two widens it to include terminal_send, because
// a mounted PTY otherwise walks straight past every deny rule.
//
// Prints the absolute path of the generated hooks.json on stdout.
//
// WHY THE GUARD IS COPIED INTO --out. Measured 2026-08-15: with the guard
// living outside the delegate's sandboxed workspace, the hook ran, exited 127
// ("No such file or directory"), and the bridge recorded `decision: pass` for
// every call -- the run looked guarded and was not. A non-2 exit is a
// NON-BLOCKING error, so an unreachable guard fails OPEN. Copying it under
// --out (which callers place inside the workspace root) makes it reachable.
//
// WHY `node "<path>"` AND NOT A BARE PATH. dsh executes command hooks through
// ctx.shell, which is PowerShell on Windows. PowerShell cannot execute a bare
// script path with a shebang; naming the interpreter works on both platforms.
//
// WHY policy.json AND NOT A SOURCED guard-env.sh. The bash original recorded
// policy as shell to `source`, quoted with `printf %q`. Node cannot source
// bash and %q has no portable equivalent -- and JSON removes shell quoting
// from the security path entirely.
//
// The two dialects currently produce identical output: dsh's Claude-Code
// bridge and Codex both read the same hooks.json matcher-group shape, the same
// tool_name/tool_input payload, and the same exit-2 block signal. --dialect is
// kept because they are free to diverge.
//
// Exit codes: 0 ok | 2 usage
import { parseArgs } from 'node:util'
import { copyFileSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const die = (msg) => { console.error(msg); process.exit(2) }

let values
try {
  ({ values } = parseArgs({
    options: {
      out: { type: 'string' },
      frozen: { type: 'string', multiple: true, default: [] },
      'allow-cmd': { type: 'string', default: '' },
      'deny-path': { type: 'string', multiple: true, default: [] },
      'deny-cmd': { type: 'string', multiple: true, default: [] },
      'deny-tool': { type: 'string', multiple: true, default: [] },
      dialect: { type: 'string', default: 'dsh' },
    },
    allowPositionals: false,
  }))
} catch (e) {
  // parseArgs throws on an unknown or malformed flag. Exit 2 (usage), never the
  // default 1: a caller that treats a non-2 exit as "carry on" would launch a
  // delegate with no guard at all.
  die(`gen-hooks: ${e.message}`)
}

if (!values.out) die('gen-hooks: --out <dir> is required')
if (!['dsh', 'codex'].includes(values.dialect)) die('gen-hooks: --dialect must be dsh or codex')

const out = resolve(values.out)
try { mkdirSync(out, { recursive: true }) } catch { die(`gen-hooks: cannot create ${out}`) }

const guardDest = join(out, 'delegation-guard.mjs')
try {
  copyFileSync(join(here, 'delegation-guard.mjs'), guardDest)
  chmodSync(guardDest, 0o755)
} catch (e) {
  die(`gen-hooks: cannot copy the guard into ${out}: ${e.message}`)
}

// The matcher is a literal alternation: the CC dialect treats a pure
// [A-Za-z0-9_|]+ pattern as exact-match alternation rather than a regex, and
// the Codex dialect reads it as an unanchored regex -- this pattern means the
// same thing under both.
//
// `read` is deliberately NOT matched by default: the delegate must read the
// contract. `apply_patch` is Codex's file writer and is easy to forget --
// measured 2026-08-15, a matcher without it let Codex rewrite a frozen test
// unopposed while the same guard blocked dsh, because dsh writes through
// write/edit.
// A tool NOT in this matcher is a tool the hook never runs for, so every name
// the guard's frozen/allowlist switch handles must appear here. This list has
// now drifted from that switch three times: `apply_patch` (Codex rewrote a
// frozen test unopposed, 2026-08-15), `pwsh` and `NotebookEdit` (below).
// hooks-matcher.test.mjs asserts the agreement so there is no fourth.
//
// `pwsh` is dsh's shell tool ON WINDOWS. Measured 2026-08-20: with it absent,
// a run with --allow-test recorded 6 tool calls and only 3 hook invocations --
// every pwsh call walked past the allowlist, and the delegate ran a command
// that was never whitelisted. The canary still printed "the boundary is live"
// because it probes the frozen-write half, which `write` does match. Windows
// was unguarded on the command half of every run.
const parts = ['write', 'edit', 'bash', 'str_replace_editor', 'apply_patch',
  'Write', 'Edit', 'MultiEdit', 'Bash', 'pwsh', 'NotebookEdit']

// Widen ONLY when the caller asked for denies, so a run without them pays no
// extra hook invocations and produces the hooks.json it always did.
//
// `read` is added here and nowhere else. The frozen-file rule deliberately lets
// the delegate read its contract; the deny-path rule is about secrets, where
// reading IS the leak. The two policies disagree about `read` on purpose.
if (values['deny-path'].length) parts.push('read', 'Read', 'grep', 'Grep', 'glob', 'Glob')
if (values['deny-path'].length || values['deny-cmd'].length) parts.push('terminal_send', 'terminal_open')
// A denied tool must be IN the matcher or the hook never runs for it. MCP names
// are [A-Za-z0-9_] only, so they stay inside the literal-alternation shape both
// dialects accept.
parts.push(...values['deny-tool'])

// WHY THE WINDOWS FORM CARRIES AN EXPLICIT `exit`. dsh runs command hooks
// through ctx.shell, which is PowerShell on Windows, and PowerShell does NOT
// adopt a native command's exit code as its own. `node guard.mjs` exiting 2 left
// the PowerShell process exiting 1 -- and 1 is a NON-BLOCKING error, so every
// BLOCK was delivered to the harness as an ALLOW.
//
// Measured 2026-08-20: a delegate briefed to edit a frozen test had the edit
// refused by the guard, printed `BLOCKED`, and wrote the file anyway. The run
// report's guard-health warning caught it; the canary did not, because it spawns
// the guard directly and never crosses the shell. Verified with clean payloads:
// plain form gives blocked -> 1, this form gives blocked -> 2, and an allowed
// call stays 0 under both.
//
// The test is `-ne 0`, not `-eq 2`, so it is fail-CLOSED: a guard that crashes
// (syntax error, exit 1) or cannot be found at all (`$LASTEXITCODE` is `$null`,
// and `$null -ne 0` is true) BLOCKS rather than allows. Verified for all four
// cases.
//
// This must NOT be emitted for a POSIX shell, where `$LASTEXITCODE` is empty and
// `exit ` would exit 0 -- the same fail-open, in the other direction. There, the
// shell already propagates the last command's status.
// `exit 2`, NOT `exit $LASTEXITCODE`: the latter re-opens the hole it is meant
// to close, because a crash (1) is then delivered as non-blocking and a missing
// interpreter (`$null`) becomes `exit 0`. The guard only ever exits 0 or 2 by
// design, so any other code is a malfunction, and a malfunctioning security
// check must block.
export const hookCommandFor = (guard) => (process.platform === 'win32'
  ? `node ${JSON.stringify(guard)}; if ($LASTEXITCODE -ne 0) { exit 2 }`
  : `node ${JSON.stringify(guard)}`)

writeFileSync(join(out, 'hooks.json'), JSON.stringify({
  hooks: {
    PreToolUse: [{
      matcher: parts.join('|'),
      hooks: [{ type: 'command', command: hookCommandFor(guardDest) }],
    }],
  },
}, null, 2) + '\n')

// The guard reads its policy from this file, resolved as its own sibling. A
// human reading the run dir afterwards can see exactly what was enforced.
writeFileSync(join(out, 'policy.json'), JSON.stringify({
  dialect: values.dialect,
  frozen: values.frozen,
  allowCmd: values['allow-cmd'],
  denyPath: values['deny-path'],
  denyCmd: values['deny-cmd'],
  denyTool: values['deny-tool'],
}, null, 2) + '\n')

console.log(join(out, 'hooks.json'))

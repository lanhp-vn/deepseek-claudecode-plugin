import { test } from 'node:test'
import assert from 'node:assert/strict'
import { auditEvents, balanceOf, checkHookCommand, hookCommandOf, matcherTools, nodeSupported, shellToolFor, WIN_EXIT_SUFFIX } from './dsh-doctor.mjs'

// The doctor's whole job is to notice a broken install. These cases are the
// broken installs that actually shipped -- each one looked correct in the
// config and passed every check that existed at the time.

test('nodeSupported tracks the ^22.19.0 || >=24 range', () => {
  assert.equal(nodeSupported('v24.18.0'), true)
  assert.equal(nodeSupported('v22.19.0'), true)
  assert.equal(nodeSupported('v22.20.3'), true)
  // Measured on the Windows host that verified 2.0.0: v22.17.1, below the range
  // both dsh and this plugin declare.
  assert.equal(nodeSupported('v22.17.1'), false)
  assert.equal(nodeSupported('v20.11.0'), false)
  assert.equal(nodeSupported('not a version'), false)
})

test('shellToolFor names the tool dsh actually registers', () => {
  assert.equal(shellToolFor('win32'), 'pwsh')
  assert.equal(shellToolFor('linux'), 'bash')
  assert.equal(shellToolFor('darwin'), 'bash')
})

const WIN_CMD = `node "C:\\run\\delegation-guard.mjs"${WIN_EXIT_SUFFIX}`
const POSIX_CMD = 'node "/run/delegation-guard.mjs"'

test('the platform-correct hook command passes', () => {
  assert.equal(checkHookCommand(WIN_CMD, 'win32').ok, true)
  assert.equal(checkHookCommand(POSIX_CMD, 'linux').ok, true)
})

// 2026-08-20: PowerShell does not adopt a native command's exit code, so the
// guard exited 2 and the hook process exited 1 -- non-blocking -- and every
// BLOCK reached the harness as an ALLOW.
test('a Windows command without the exit suffix fails', () => {
  const r = checkHookCommand(POSIX_CMD.replace('/run/', 'C:\\run\\'), 'win32')
  assert.equal(r.ok, false)
  assert.match(r.detail, /ALLOW/)
})

// The same fail-open in the other direction: on a POSIX shell $LASTEXITCODE is
// empty, so `exit ` exits 0.
test('the PowerShell suffix on a POSIX shell fails', () => {
  const r = checkHookCommand(WIN_CMD, 'linux')
  assert.equal(r.ok, false)
  assert.match(r.detail, /POSIX/)
})

test('a hook that does not name an interpreter fails', () => {
  // PowerShell cannot execute a bare script path, and the harness reads the
  // resulting non-2 exit as non-blocking.
  const r = checkHookCommand('/run/delegation-guard.mjs', 'linux')
  assert.equal(r.ok, false)
  assert.match(r.detail, /interpreter/)
})

test('a hook that runs something other than the guard fails', () => {
  assert.equal(checkHookCommand('node "/run/something-else.mjs"', 'linux').ok, false)
  assert.equal(checkHookCommand('', 'linux').ok, false)
})

test('matcherTools and hookCommandOf read the generated shape', () => {
  const hooks = { hooks: { PreToolUse: [{ matcher: 'write|edit|pwsh', hooks: [{ type: 'command', command: WIN_CMD }] }] } }
  assert.deepEqual(matcherTools(hooks), ['write', 'edit', 'pwsh'])
  assert.equal(hookCommandOf(hooks), WIN_CMD)
  assert.deepEqual(matcherTools({}), [])
  assert.equal(hookCommandOf({}), '')
})

const call = (name, args) => ({ type: 'tool/call', data: { name, arguments: JSON.stringify(args) } })
const hook = (decision, exitCode) => ({ type: 'hook/result', data: { decision, exitCode } })
const TOOLS = ['write', 'edit', 'pwsh', 'read']

test('a healthy run: every matched call got a decision, refusals were refused', () => {
  const events = [
    call('write', { file_path: 'hello.txt' }), hook('pass', 0),
    call('pwsh', { command: 'node ok.mjs' }), hook('pass', 0),
    call('write', { file_path: 'contract.txt' }), hook('block', 2),
    call('pwsh', { command: 'echo nope' }), hook('block', 2),
    { type: 'assistant/message', data: { usage: { inputTokens: 10, outputTokens: 5, reasoningTokens: 3, cacheReadTokens: 100 } } },
  ]
  const a = auditEvents(events, TOOLS, { frozenName: 'contract.txt', deniedCmd: 'echo nope' })
  assert.equal(a.matched.length, 4)
  assert.equal(a.hooks.length, 4)
  assert.equal(a.blocks.length, 2)
  assert.equal(a.broken.length, 0)
  assert.equal(a.frozenAttempt, true)
  assert.equal(a.deniedCmdAttempt, true)
  assert.equal(a.tokens.reasoning, 3)
  assert.equal(a.tokens.steps, 1)
})

// The 2026-08-20 matcher gap: `pwsh` absent from the matcher, so shell calls
// were never hooked. 6 calls, 3 decisions, an allowlist enforcing nothing.
test('a matcher gap shows up as matched calls outnumbering decisions', () => {
  const events = [
    call('write', { file_path: 'hello.txt' }), hook('pass', 0),
    call('pwsh', { command: 'echo nope' }),
  ]
  const withPwsh = auditEvents(events, TOOLS)
  assert.equal(withPwsh.matched.length, 2)
  assert.equal(withPwsh.hooks.length, 1)   // the gap the doctor reports

  const withoutPwsh = auditEvents(events, ['write', 'edit'])
  assert.equal(withoutPwsh.matched.length, 1)  // uncovered calls are not "matched"
})

// A guard that cannot execute exits 127, which the harness treats as a
// non-blocking error: the call is ALLOWED and the run only looks guarded.
test('a non-2, non-0 hook exit is reported as broken', () => {
  const a = auditEvents([call('write', { file_path: 'x' }), hook('pass', 127)], TOOLS)
  assert.equal(a.broken.length, 1)
  assert.equal(a.blocks.length, 0)
})

test('an exit 2 counts as a block even when the decision field is missing', () => {
  const a = auditEvents([hook(undefined, 2)], TOOLS)
  assert.equal(a.blocks.length, 1)
  assert.equal(a.broken.length, 0)
})

test('attempts are only counted for the tools that can make them', () => {
  // Reading the contract is allowed and deliberately not an attempt to edit it:
  // the frozen rule and the deny rule disagree about `read` on purpose.
  const a = auditEvents([call('read', { file_path: 'contract.txt' })], TOOLS, { frozenName: 'contract.txt', deniedCmd: 'echo nope' })
  assert.equal(a.frozenAttempt, false)
  assert.equal(a.deniedCmdAttempt, false)
})

test('an empty log audits to zeros rather than throwing', () => {
  const a = auditEvents([], TOOLS, { frozenName: 'contract.txt' })
  assert.equal(a.calls.length, 0)
  assert.equal(a.hooks.length, 0)
  assert.equal(a.frozenAttempt, false)
  assert.equal(a.tokens.steps, 0)
})

test('balanceOf reads the balance and refuses to guess', () => {
  assert.equal(balanceOf({ balance_infos: [{ total_balance: '9.60', currency: 'USD' }] }), 9.6)
  assert.equal(balanceOf({ balance_infos: [{ total_balance: '0.00' }] }), 0)
  // Null, not 0: an unreadable payload must not read as an empty balance, which
  // would block the live tier on every account whose response shape changed.
  assert.equal(balanceOf({}), null)
  assert.equal(balanceOf(null), null)
})

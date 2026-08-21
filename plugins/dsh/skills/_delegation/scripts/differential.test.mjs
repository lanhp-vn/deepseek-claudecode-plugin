// differential.test.mjs: bash guard vs Node guard, same inputs, same decisions.
//
// Green on both contract suites proves each implementation satisfies the
// contract. It does not prove they AGREE outside it. This does.
//
// Linux only -- Windows has no bash reference. This is a port-correctness
// check, not a platform check.
//
// A divergence here is a real finding. Investigate which implementation is
// right before changing either: the bash one is not automatically correct, it
// is only the incumbent. Both known divergences so far were bash bugs found
// this way (the cwd-globbing literal_of, and the deny-cmd glob semantics).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir, platform } from 'node:os'
import { join } from 'node:path'

const BASH = process.env.BASH_GUARD   // .../delegation-guard.sh
const NODE = process.env.NODE_GUARD   // .../delegation-guard.mjs
const skip = platform() === 'win32' ? 'no bash reference on Windows'
  : (!BASH || !NODE) ? 'set BASH_GUARD and NODE_GUARD' : false

const tmp = mkdtempSync(join(tmpdir(), 'diff-'))
// The guard resolves policy.json as its OWN sibling, not relative to cwd, so
// the Node side must run from a copy sitting beside the policy -- which is
// also exactly how gen-hooks deploys it into the run dir.
const NODE_COPY = join(tmp, 'delegation-guard.mjs')
if (!skip) copyFileSync(NODE, NODE_COPY)

// Both sides run from a POPULATED working directory on purpose. The bash
// original's free-text deny scan silently depended on cwd contents (fixed
// 2026-08-20); an empty cwd would have hidden it here too.
const cwd = mkdtempSync(join(tmpdir(), 'diffcwd-'))
for (const n of ['a-file-name-much-longer-than-credentials.txt', 'notes.md', 'x.enc']) {
  writeFileSync(join(cwd, n), '')
}

const FROZEN = '/repo/tests/test_contract.py'
const ALLOW = 'uv run --with pytest python -m pytest'
const DENY_PATH = ['credentials/**', '.env', '**/*.enc']
const DENY_CMD = ['git push', 'adb * shell reboot', '*scripts/demos/*', 'distil model run-training']
const DENY_TOOL = ['mcp__gitnexus__cypher']

function runBash (payload) {
  return new Promise((r) => {
    const p = spawn('bash', [BASH], {
      cwd,
      env: {
        ...process.env,
        DELEGATION_FROZEN: FROZEN,
        DELEGATION_ALLOW_CMD: ALLOW,
        DELEGATION_DENY_PATH: DENY_PATH.join('\n'),
        DELEGATION_DENY_CMD: DENY_CMD.join('\n'),
        DELEGATION_DENY_TOOL: DENY_TOOL.join('\n'),
      },
      stdio: ['pipe', 'ignore', 'ignore'],
    })
    p.on('close', r); p.stdin.end(payload)
  })
}

function runNode (payload) {
  writeFileSync(join(tmp, 'policy.json'), JSON.stringify({
    frozen: [FROZEN], allowCmd: ALLOW, denyPath: DENY_PATH, denyCmd: DENY_CMD, denyTool: DENY_TOOL,
  }))
  return new Promise((r) => {
    const p = spawn('node', [NODE_COPY], { cwd, stdio: ['pipe', 'ignore', 'ignore'] })
    p.on('close', r); p.stdin.end(payload)
  })
}

// The awkward cases: where a port is most likely to diverge.
const CASES = [
  // --- the command allowlist, and every way out of it ---
  '{"tool_name":"bash","tool_input":{"command":"uv run --with pytest python -m pytest -q"}}',
  '{"tool_name":"bash","tool_input":{"command":"A=1 B=2 uv run --with pytest python -m pytest"}}',
  '{"tool_name":"bash","tool_input":{"command":"UV_CACHE_DIR=/tmp/uv uv run --with pytest python -m pytest"}}',
  '{"tool_name":"bash","tool_input":{"command":"uv run --with pytest python -m pytest 2>&1 | head -50"}}',
  '{"tool_name":"bash","tool_input":{"command":"uv run --with pytest python -m pytest `id`"}}',
  '{"tool_name":"bash","tool_input":{"command":"uv run --with pytest python -m pytest $(id)"}}',
  '{"tool_name":"bash","tool_input":{"command":"uv run --with pytest python -m pytest\\nrm -rf /"}}',
  '{"tool_name":"bash","tool_input":{"command":"uv run --with pytest python -m pytest > /etc/passwd"}}',
  '{"tool_name":"bash","tool_input":{"command":"=notavar uv run --with pytest python -m pytest"}}',
  '{"tool_name":"bash","tool_input":{"command":""}}',
  // --- frozen files ---
  '{"tool_name":"write","tool_input":{"file_path":"tests/test_contract.py"}}',
  '{"tool_name":"write","tool_input":{"file_path":"/other/tests/test_contract.py"}}',
  '{"tool_name":"write","tool_input":{"file_path":"/repo/tests/test_contract.py"}}',
  '{"tool_name":"write","tool_input":{"file_path":"src/impl.py"}}',
  '{"tool_name":"write","tool_input":{}}',
  '{"tool_name":"str_replace_editor","tool_input":{"path":"tests/test_contract.py"}}',
  '{"tool_name":"read","tool_input":{"file_path":"/repo/tests/test_contract.py"}}',
  // --- deny-path ---
  '{"tool_name":"read","tool_input":{"file_path":".envrc"}}',
  '{"tool_name":"read","tool_input":{"file_path":".env"}}',
  '{"tool_name":"read","tool_input":{"file_path":"a/b/credentials/x.json"}}',
  '{"tool_name":"read","tool_input":{"file_path":"deep/nested/key.enc"}}',
  '{"tool_name":"read","tool_input":{"file_path":"docs/readme.md"}}',
  '{"tool_name":"glob","tool_input":{"pattern":"credentials/**"}}',
  '{"tool_name":"glob","tool_input":{"pattern":"src/**/*.py"}}',
  '{"tool_name":"grep","tool_input":{"path":"docs","pattern":"credentials"}}',
  '{"tool_name":"grep","tool_input":{"path":"credentials","pattern":"token"}}',
  '{"tool_name":"terminal_open","tool_input":{"cwd":"credentials"}}',
  // --- deny-cmd, including the interior-* patterns that broke the first port ---
  '{"tool_name":"terminal_send","tool_input":{"text":"adb -s 1 shell reboot"}}',
  '{"tool_name":"terminal_send","tool_input":{"text":"ls -la"}}',
  '{"tool_name":"bash","tool_input":{"command":"/usr/bin/adb -s /dev/ttyUSB0 shell reboot"}}',
  '{"tool_name":"bash","tool_input":{"command":"uv run python /home/x/scripts/demos/go.py"}}',
  '{"tool_name":"bash","tool_input":{"command":"distil model run-training --now"}}',
  '{"tool_name":"bash","tool_input":{"command":"git push origin main"}}',
  '{"tool_name":"bash","tool_input":{"command":"cat credentials/token.json"}}',
  // --- deny-tool ---
  '{"tool_name":"mcp__gitnexus__cypher","tool_input":{}}',
  '{"tool_name":"mcp__gitnexus__query","tool_input":{}}',
  // --- apply_patch ---
  '{"tool_name":"apply_patch","tool_input":{"command":"*** Begin Patch\\n*** Update File: tests/test_contract.py\\n*** End Patch"}}',
  '{"tool_name":"apply_patch","tool_input":{"command":"*** Begin Patch\\n*** Update File: src/impl.py\\n*** End Patch"}}',
  '{"tool_name":"apply_patch","tool_input":{"command":"*** Begin Patch\\n*** Add File: credentials/token.json\\n*** End Patch"}}',
  // --- malformed: every one of these must fail CLOSED, identically ---
  'not json',
  '',
  '{}',
  '{"tool_name":""}',
  '{"tool_name":123}',
  '{"tool_name":["bash"]}',
  '{"tool_name":"bash","tool_input":{"command":123}}',
  '{"tool_name":"write","tool_input":{"file_path":["tests/test_contract.py"]}}',
  '{"tool_name":"read","tool_input":null}',
  '{"tool_name":"bash"}',
  'null',
]

for (const [i, payload] of CASES.entries()) {
  test(`case ${i}: bash and Node agree on ${payload.slice(0, 72)}`, { skip }, async () => {
    const [b, n] = await Promise.all([runBash(payload), runNode(payload)])
    assert.equal(n, b, `divergence on ${payload}`)
  })
}

#!/usr/bin/env node
// deepseek-run.mjs: run one delegated implementation task on DeepSeek V4, then
// report what the delegate ACTUALLY did so Claude can review and test it.
//
// Node port of the bash original's argument layer and dry-run path. Everything
// here composes the run artifacts and exits BEFORE spending a token; the live
// launch of either backend is left to a later task (see the TODO(task-6b)
// markers). The module is importable so later tasks can unit-test the argument
// layer through resolveRun() without launching anything.
//
// Usage:
//   deepseek-run.mjs [--backend dsh|claude-code] [-C <dir>] [-m pro|flash]
//                    [--frozen <path>]... [--allow-test "<cmd>"]
//                    [--overlay <file>]... [--no-overlay] "<brief>"
//   deepseek-run.mjs [-C <dir>] -f <brief-file>
//   cat brief.md | deepseek-run.mjs [-C <dir>]
//
// TWO BACKENDS.
//
//   --backend dsh          (default) DeepSeek Harness, `dsh --profile headless`.
//   --backend claude-code  Claude Code pointed at api.deepseek.com/anthropic.
//
// THE GUARD (dsh backend). --frozen paths cannot be written and --allow-test is
// the only shell command permitted, both enforced by a generated hooks.json that
// the harness runs before each tool call. This blocks the DIRECT route and logs
// every attempt. It is NOT a boundary: measured 2026-08-15, a delegate wrote a
// conftest.py, let the whitelisted pytest command execute it, and rewrote a
// frozen test that way. ALWAYS read `git diff -- <frozen>` afterwards.
//
// Exit codes: 0 ok · 2 bad usage · 3 no API key / dsh not installed · other =
// the delegate's exit code.

import { spawnSync } from 'node:child_process'
import {
  existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// The hook generator lives in the same tree, not relative to cwd: the wrapper
// is invoked from any directory, so `here` is the only stable anchor.
const here = dirname(fileURLToPath(import.meta.url))

const USAGE = `deepseek-run.mjs: run one delegated implementation task on DeepSeek V4.

Usage:
  deepseek-run.mjs [--backend dsh|claude-code] [-C <dir>] [-m pro|flash]
                   [--frozen <path>]... [--allow-test "<cmd>"]
                   [--overlay <file>]... [--no-overlay] "<brief>"
  deepseek-run.mjs [-C <dir>] -f <brief-file>
  cat brief.md | deepseek-run.mjs [-C <dir>]
`

// A usage error exits 2, never 1: a caller that treats a non-2 exit as "carry
// on" would launch a delegate with no guard at all. Help exits 0 on stdout.
class UsageError extends Error {}
class Help extends Error {}

/**
 * Parse and resolve the argument layer without launching anything.
 *
 * argv is the argument vector (process.argv.slice(2) when run as a script).
 * Throws UsageError (exit 2) on bad usage and Help (exit 0) on -h/--help.
 */
export function resolveRun (argv) {
  let dir = process.cwd()
  let model = 'pro'
  let effort = 'high'
  let backend = 'dsh'
  let prompt = ''
  let briefFile = ''
  let drydir = ''
  let allowTest = ''
  let turns = 40
  let dry = false
  let bypass = false
  let noOverlay = false
  const frozen = []
  const allow = []
  const overlays = []
  const denyPath = []
  const denyCmd = []
  const denyTool = []

  // Hand-rolled the way the bash `while`/`case` does: node:util parseArgs will
  // not accept a bare positional mixed with options, and it rejects -C-style
  // short options with values. The hand loop keeps the flag semantics identical.
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    // Take the next argument as this flag's value; a flag at the end of argv is
    // the same `${2:?}` failure the bash original reports.
    const req = (what) => {
      if (i + 1 >= argv.length) throw new UsageError(`${a} requires ${what}`)
      return argv[++i]
    }
    switch (a) {
      case '-C': case '--cd': dir = req('a directory'); break
      case '-f': case '--file': briefFile = req('a file path'); break
      case '-m': case '--model': model = req('pro|flash'); break
      case '-e': case '--effort': effort = req('high|max'); break
      case '--backend': backend = req('dsh|claude-code'); break
      case '--frozen': frozen.push(req('a path')); break
      case '--overlay': overlays.push(req('a file')); break
      case '--no-overlay': noOverlay = true; break
      case '--deny-path': denyPath.push(req('a glob')); break
      case '--deny-cmd': denyCmd.push(req('a pattern')); break
      case '--deny-tool': denyTool.push(req('a tool name')); break
      case '--dry-run': dry = true; break
      case '--dry-run-dir': drydir = req('a path'); break
      case '--max-turns': turns = Number(req('a number')); break
      // Least-privilege self-verification. Under acceptEdits the delegate can
      // write files but every Bash call needs approval that headless cannot
      // give, so it stops at "awaiting your approval" instead of proving its
      // own work (observed 2026-08-09). Whitelisting just the test command lets
      // it check itself without handing it a general shell.
      //   --allow-test "uv run --with pytest python -m pytest"
      case '--allow-test':
        allowTest = req('a command prefix')
        allow.push(`Bash(${allowTest}:*)`)
        break
      case '--allow': allow.push(req('a tool spec')); break
      case '--bypass': bypass = true; break
      case '-h': case '--help': throw new Help()
      // Like the bash `*)`: a bare positional is the brief. Unrecognised tokens
      // fall through to it too, and (also like bash) the last one wins.
      default: prompt = a; break
    }
  }

  if (backend !== 'dsh' && backend !== 'claude-code') {
    throw new UsageError(`--backend must be dsh or claude-code (got '${backend}')`)
  }

  let st
  try { st = statSync(dir) } catch { throw new UsageError(`not a directory: ${dir}`) }
  if (!st.isDirectory()) throw new UsageError(`not a directory: ${dir}`)
  // `cd "$dir" && pwd` in bash: resolve symlinks to the physical path so the
  // workspace root recorded in patch.yml is where the sandbox actually mounts.
  dir = realpathSync(dir)

  if (briefFile) {
    // A missing/unreadable file becomes an empty brief, which then fails the
    // same "no brief" check -- identical to bash's `prompt="$(cat "$file")"`.
    try { prompt = readFileSync(briefFile, 'utf8') } catch { prompt = '' }
  } else if (prompt === '' && !process.stdin.isTTY) {
    prompt = readFileSync(0, 'utf8')
  }
  if (!prompt.trim()) {
    throw new UsageError('no brief (arg, -f <file>, or stdin)')
  }

  return {
    dir, model, backend, frozen, allowTest, allow,
    overlays, noOverlay, denyPath, denyCmd, denyTool,
    dry, drydir, briefFile, prompt, effort, bypass, turns,
  }
}

// ---------------------------------------------------------------------------
// Backend: dsh (default)
// ---------------------------------------------------------------------------
function runDsh (r) {
  // The guard MUST live inside the workspace root. Measured 2026-08-15: a guard
  // outside it exits 127 under the sandbox, and a non-2 exit is a NON-BLOCKING
  // error, so every call is allowed and the run only LOOKS guarded.
  const rundir = resolve(r.drydir || join(r.dir, '.delegation-run'))
  rmSync(rundir, { recursive: true, force: true })
  try { mkdirSync(rundir, { recursive: true }) } catch {
    console.error(`deepseek-run: cannot create ${rundir}`)
    process.exit(2)
  }

  // The per-repo overlay table (keyed on the git toplevel basename) is
  // deliberately DELETED in this port. It is replaced, in a later task, by a
  // .deepseek/ directory discovered at the git toplevel. Only the explicit
  // --overlay list survives here; --no-overlay has nothing to gate until that
  // later task re-adds the automatic base/repo overlays.
  const patchFiles = []
  for (const ov of r.overlays) {
    const resolved = resolve(ov)
    if (!existsSync(resolved)) {
      console.error(`deepseek-run: no such overlay: ${ov}`)
      process.exit(2)
    }
    patchFiles.push(resolved)
  }

  // Compose the guard through the hook generator; it writes hooks.json,
  // delegation-guard.mjs and policy.json into the run dir. We never write those
  // ourselves.
  const genArgs = ['--out', rundir, '--dialect', 'dsh']
  for (const f of r.frozen) genArgs.push('--frozen', f)
  if (r.allowTest) genArgs.push('--allow-cmd', r.allowTest)
  for (const g of r.denyPath) genArgs.push('--deny-path', g)
  for (const p of r.denyCmd) genArgs.push('--deny-cmd', p)
  for (const t of r.denyTool) genArgs.push('--deny-tool', t)
  const genHooks = join(here, '..', 'skills', '_delegation', 'scripts', 'gen-hooks.mjs')
  const gen = spawnSync(process.execPath, [genHooks, ...genArgs], {
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  if (gen.status !== 0) {
    console.error('deepseek-run: could not generate the guard')
    process.exit(2)
  }

  const modelId = r.model === 'pro' ? 'deepseek-v4-pro'
    : r.model === 'flash' ? 'deepseek-v4-flash'
      : r.model

  // Every per-run choice is a cordis patch row: the headless app's entire command
  // line is the task positional plus -h (verified from its own --help), so there
  // is no --model or --permission-mode flag to reach for.
  writeFileSync(join(rundir, 'patch.yml'), `- id: agent-default-model
  config:
    provider: deepseek-official
    model: ${modelId}

- id: sandbox-policy
  config:
    mode: workspace-write
    workspaceRoot: "${r.dir}"

# tool-web already ships fetch:false in the headless composition; this keeps it
# off explicitly so a future default change does not silently grant the delegate
# a fetch backend that does not block private-network targets.
- id: tool-web
  config:
    fetch: false
    searchTimeoutMs: 60000

- insert:
    - id: hooks-cc
      name: '@deepseek-ai/dsh-hooks-claude-code'
      config:
        configPath: ${join(rundir, 'hooks.json')}
        projectDir: ${r.dir}
`)

  // Overlays first, the generated patch.yml last: `--patch` layers apply in
  // order, so this keeps per-run choices (model, workspace root, hook mount)
  // winning over anything an overlay happens to touch.
  const patchArgs = []
  for (const f of patchFiles) patchArgs.push('--patch', f)
  patchArgs.push('--patch', join(rundir, 'patch.yml'))

  if (r.dry) {
    console.error(`>>> deepseek-run: DRY RUN (backend: dsh)  model: ${modelId}  dir: ${r.dir}`)
    if (patchFiles.length) console.error(`>>> overlays: ${patchFiles.join(' ')}`)
    // A dry run is exactly when you want to read the policy back, so print it
    // here too rather than only on the live path.
    if (r.denyPath.length) console.error(`>>> denied paths: ${r.denyPath.join(' ')}`)
    if (r.denyCmd.length) console.error(`>>> denied commands: ${r.denyCmd.length} patterns`)
    if (r.denyTool.length) console.error(`>>> denied tools: ${r.denyTool.join(' ')}`)
    console.error(`>>> artifacts: ${rundir}`)
    process.exit(0)
  }

  console.error(`>>> deepseek-run: backend: dsh  model: ${modelId}  dir: ${r.dir}`)
  if (patchFiles.length) console.error(`>>> overlays: ${patchFiles.join(' ')}`)
  if (r.denyPath.length) console.error(`>>> denied paths: ${r.denyPath.join(' ')}`)
  if (r.denyCmd.length) console.error(`>>> denied commands: ${r.denyCmd.length} patterns (see ${join(rundir, 'policy.json')})`)
  if (r.denyTool.length) console.error(`>>> denied tools: ${r.denyTool.join(' ')}`)
  if (r.frozen.length) console.error(`>>> frozen: ${r.frozen.join(' ')}`)
  if (r.allowTest) console.error(`>>> only permitted command: ${r.allowTest}`)

  // -------------------------------------------------------------------------
  // Live launch -- NOT ported yet (task-6b). The tests only exercise
  // --dry-run and never reach this branch.
  //
  // TODO(task-6b): `command -v dsh` first (exit 3 if missing, with the
  //   "npm i -g @deepseek-ai/dsh" and "--backend claude-code" hints), then run
  //   in $dir with DELEGATION_FROZEN / DELEGATION_ALLOW_CMD / DELEGATION_DENY_*
  //   in the environment and
  //     env -u DEEPSEEK_API_KEY dsh --profile headless \
  //       <patchArgs...> "$prompt"
  //   The `env -u DEEPSEEK_API_KEY` is load-bearing, not hygiene: the inherited
  //   process environment ALWAYS wins over $DSH_HOME/.credentials.yaml.
  // -------------------------------------------------------------------------
  console.error('deepseek-run: live dsh launch is not implemented (task-6b)')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Backend: claude-code (the original route)
// ---------------------------------------------------------------------------
function runClaudeCode (r) {
  // `[1m]` selects the 1M-token context variant; both IDs come from DeepSeek's
  // own Claude Code guide, not from guesswork.
  const modelId = r.model === 'pro' ? 'deepseek-v4-pro[1m]'
    : r.model === 'flash' ? 'deepseek-v4-flash[1m]'
      : r.model

  // deepseek-v4-pro accepts only high and max. `low` does NOT error: it is
  // silently accepted (verified live 2026-08-09), so a typo would quietly change
  // behaviour rather than failing loudly. Catch it here instead.
  if (r.model === 'pro' && r.effort !== 'high' && r.effort !== 'max') {
    console.error(`deepseek-run: pro supports only -e high|max (got '${r.effort}'); the API accepts it silently`)
    process.exit(2)
  }

  if (r.dry) {
    console.error(`>>> deepseek-run: DRY RUN (backend: claude-code)  model: ${modelId}  dir: ${r.dir}`)
    process.exit(0)
  }

  // -------------------------------------------------------------------------
  // Live launch setup -- the spawn itself is NOT ported (task-6b). The env
  // object below is assembled here, though, because that is where the
  // ANTHROPIC_* variables are scoped to the child process.
  // -------------------------------------------------------------------------

  // The key comes from $DEEPSEEK_API_KEY or ~/.deepseek/api-key.
  let token = process.env.DEEPSEEK_API_KEY || ''
  if (!token) {
    // homedir(), not $HOME: HOME is normally UNSET on Windows (USERPROFILE is
    // the variable there), so `process.env.HOME || ''` resolved the key path
    // relative to the current directory -- on the one platform this whole port
    // exists to support.
    const keyPath = join(homedir(), '.deepseek', 'api-key')
    if (existsSync(keyPath)) token = readFileSync(keyPath, 'utf8').replace(/[\s\r\n]/g, '')
  }
  if (!token) {
    console.error('deepseek-run: no API key: run scripts/setup-deepseek.sh')
    process.exit(3)
  }

  const cfg = join(homedir(), '.deepseek', 'claude-home')
  mkdirSync(cfg, { recursive: true })
  const settings = join(cfg, 'settings.json')
  if (!existsSync(settings)) writeFileSync(settings, '{}')

  const perm = r.bypass ? 'bypassPermissions' : 'acceptEdits'
  if (r.bypass) console.error('>>> deepseek-run: PERMISSIONS BYPASSED (all tools auto-approved)')
  if (r.allow.length) console.error(`>>> allowed beyond edits: ${r.allow.join(' ')}`)

  // WHY THE ENV VARS ARE SET HERE AND NOT IN settings.json. Putting
  // ANTHROPIC_BASE_URL in ~/.claude/settings.json redirects EVERY Claude Code
  // session on this machine to DeepSeek, including the one supervising this
  // delegation. This wrapper scopes them to the child process instead.
  //
  // WHY A SEPARATE CLAUDE_CONFIG_DIR. The delegate must not inherit the
  // operator's plugins, hooks and MCP servers: each injects tokens into a
  // context DeepSeek bills per token, and none help it write code.
  const env = {
    CLAUDE_CONFIG_DIR: cfg,
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    ANTHROPIC_AUTH_TOKEN: token,
    ANTHROPIC_MODEL: modelId,
    ANTHROPIC_DEFAULT_OPUS_MODEL: modelId,
    ANTHROPIC_DEFAULT_SONNET_MODEL: modelId,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash[1m]',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_EFFORT_LEVEL: r.effort,
  }

  console.error(`>>> deepseek-run: backend: claude-code  model: ${modelId}  effort: ${r.effort}  perm: ${perm}  dir: ${r.dir}`)

  // TODO(task-6b): launch with `env -u ANTHROPIC_API_KEY` so an inherited
  //   Anthropic key cannot silently bill Anthropic for work meant to run on
  //   DeepSeek, spreading <env> over the child, then:
  //     claude -p "$prompt" --add-dir "$dir" --permission-mode "$perm" \
  //       --max-turns "$turns" [--allowedTools <allow...>] --output-format json
  //   with stdout to <logdir>/result.json and stderr to <logdir>/stderr.log.
  console.error('deepseek-run: live claude-code launch is not implemented (task-6b)')
  process.exit(1)
}

function main (argv) {
  let r
  try {
    r = resolveRun(argv)
  } catch (e) {
    if (e instanceof Help) { process.stdout.write(USAGE); process.exit(0) }
    if (e instanceof UsageError) { process.stderr.write(`deepseek-run: ${e.message}\n`); process.exit(2) }
    throw e
  }
  if (r.backend === 'dsh') runDsh(r)
  else runClaudeCode(r)
}

// Runnable as a script, importable as a module (resolveRun for unit tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2))
}

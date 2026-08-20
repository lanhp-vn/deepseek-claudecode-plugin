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

import { discoverSeam, loadMachine, loadRepoPolicy, substituteMachine, MissingMachineKey } from './seam.mjs'
import { composePolicy } from './policy.mjs'
import { approvalStore, hashOverlay, isApproved, recordApproval, refusalMessage, summarise } from './approval.mjs'
import { runCanary, PROBE_PATH } from './canary.mjs'

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
  deepseek-run.mjs --approve-overlay -C <dir>    # review and approve .deepseek/overlay.yml

Per-repo capability comes from <repo>/.deepseek/overlay.yml and its deny set
from <repo>/.deepseek/policy.yml. A repo policy can only ADD denies; the only
way to lift one is --allow-tool, which never lives in a file.

  --allow-tool <name>   lift one floor/repo deny for this run (repeatable)
  --approve-overlay     record approval of this repo's overlay, then exit
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
  const allowTool = []
  let approveOverlay = false

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
      // The ONLY way to lift a deny. Deliberately a flag and not a file: it
      // lives in a hand and in the session log, so nothing arrives with a clone.
      case '--allow-tool': allowTool.push(req('a tool name')); break
      case '--approve-overlay': approveOverlay = true; break
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
  } else if (prompt === '' && !approveOverlay && !process.stdin.isTTY) {
    // Reading fd 0 can throw EAGAIN when stdin is a non-blocking pipe with
    // nothing in it -- which is exactly how this is invoked from a tool
    // harness. bash's `$(cat)` just yields an empty string there, and an
    // unhandled EAGAIN crash is a much worse answer than "no brief". Measured
    // 2026-08-20: `--approve-overlay -C <dir>` died this way.
    try { prompt = readFileSync(0, 'utf8') } catch { prompt = '' }
  }
  // --approve-overlay reviews and records; it never runs a delegation, so it is
  // the one mode that legitimately has no brief.
  if (!approveOverlay && !prompt.trim()) {
    throw new UsageError('no brief (arg, -f <file>, or stdin)')
  }

  return {
    dir, model, backend, frozen, allowTest, allow,
    overlays, noOverlay, denyPath, denyCmd, denyTool, allowTool, approveOverlay,
    dry, drydir, briefFile, prompt, effort, bypass, turns,
  }
}

// ---------------------------------------------------------------------------
// Reporting, shared by both backends. Untracked files hide from `git diff`, so
// `git status --short` is printed too -- without it a migration that adds 146
// new files reports as "1 file changed".
// ---------------------------------------------------------------------------
function reportTree (r) {
  const git = (args) => spawnSync('git', ['-C', r.dir, ...args], { encoding: 'utf8' }).stdout ?? ''
  console.log('\n===== Working-tree changes (git status --short) =====')
  console.log(git(['status', '--short']) || '(clean, or not a git repo)')
  console.log('===== Diff stat =====')
  console.log(git(['--no-pager', 'diff', '--stat']))
  if (r.frozen.length) {
    console.log('===== FROZEN FILES -- this must be empty =====')
    console.log(git(['--no-pager', 'diff', '--stat', '--', ...r.frozen]))
    console.log('(anything above means the contract was edited; that is an automatic bounce)')
  }
}

function gitToplevel (dir) {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' })
  return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null
}

const runReport = (dir) => {
  const sr = join(here, '..', 'skills', '_delegation', 'scripts', 'session-report.mjs')
  spawnSync(process.execPath, [sr, dir], { stdio: 'inherit' })
}

// ---------------------------------------------------------------------------
// Backend: dsh (default)
// ---------------------------------------------------------------------------
async function runDsh (r) {
  // The guard MUST live inside the workspace root. Measured 2026-08-15: a guard
  // outside it exits 127 under the sandbox, and a non-2 exit is a NON-BLOCKING
  // error, so every call is allowed and the run only LOOKS guarded.
  const rundir = resolve(r.drydir || join(r.dir, '.delegation-run'))
  rmSync(rundir, { recursive: true, force: true })
  try { mkdirSync(rundir, { recursive: true }) } catch {
    console.error(`deepseek-run: cannot create ${rundir}`)
    process.exit(2)
  }

  // -------------------------------------------------------------------------
  // The seam. The per-repo overlay table that used to live here -- keyed on the
  // git toplevel basename, inside one operator's dotfiles -- is deleted. A
  // repository now declares its own capability and its own deny set, together.
  // -------------------------------------------------------------------------
  const repoRoot = gitToplevel(r.dir) ?? r.dir
  const seam = discoverSeam(repoRoot)
  const home = homedir()
  const patchFiles = []

  // 00-base.yml applies to every delegation and is config-only.
  if (!r.noOverlay) {
    const base = join(here, '..', 'overlays', '00-base.yml')
    if (existsSync(base)) patchFiles.push(base)
  }

  if (seam.overlayPath) {
    const raw = readFileSync(seam.overlayPath, 'utf8')
    // Hash the RAW bytes, before substitution: substituting first would make
    // the hash machine-dependent and re-arm the gate on every machine.
    const hash = hashOverlay(raw)
    const store = approvalStore(home)

    if (r.approveOverlay) {
      console.log(`${seam.overlayPath}\n`)
      for (const line of summarise(raw)) console.log(`  ${line}`)
      recordApproval(store, repoRoot, hash)
      console.log(`\napproved for ${repoRoot}`)
      console.log('Editing the overlay re-arms this gate, because the hash changes.')
      process.exit(0)
    }

    // Capability must never arrive silently with a git clone.
    if (!isApproved(store, repoRoot, hash)) {
      console.error(refusalMessage({ overlayPath: seam.overlayPath, overlayText: raw, repoRoot }))
      process.exit(2)
    }

    if (!r.noOverlay) {
      let text
      try {
        text = substituteMachine(raw, loadMachine(home))
      } catch (e) {
        if (e instanceof MissingMachineKey) { console.error(`deepseek-run: ${e.message}`); process.exit(2) }
        throw e
      }
      // Substitution is textual and the result is what dsh reads, so the
      // composed copy lands in the run dir where a human can read it back.
      const composed = join(rundir, 'repo-overlay.yml')
      writeFileSync(composed, text)
      patchFiles.push(composed)
    }
  } else if (r.approveOverlay) {
    console.error(`deepseek-run: ${repoRoot} has no .deepseek/overlay.yml to approve`)
    process.exit(2)
  }

  for (const ov of r.overlays) {
    const resolved = resolve(ov)
    if (!existsSync(resolved)) {
      console.error(`deepseek-run: no such overlay: ${ov}`)
      process.exit(2)
    }
    patchFiles.push(resolved)
  }

  // -------------------------------------------------------------------------
  // Policy: FLOOR union repo policy union CLI denies, minus only what the
  // OPERATOR lifted. A committed file can tighten and can never loosen.
  // -------------------------------------------------------------------------
  let repoPolicy = null
  try {
    repoPolicy = loadRepoPolicy(seam.policyPath)
  } catch (e) {
    console.error(`deepseek-run: ${e.message}`)
    process.exit(2)
  }
  const pol = composePolicy({
    repoPolicy,
    cliDeny: { denyPath: r.denyPath, denyCmd: r.denyCmd, denyTool: r.denyTool },
    allowTool: r.allowTool,
  })

  // Compose the guard through the hook generator; it writes hooks.json,
  // delegation-guard.mjs and policy.json into the run dir. We never write those
  // ourselves.
  const genArgs = ['--out', rundir, '--dialect', 'dsh']
  for (const f of r.frozen) genArgs.push('--frozen', f)
  // The canary's probe path is frozen for the WHOLE run, not just the self
  // test, so the guard stays provably live rather than only having been live
  // once at startup.
  genArgs.push('--frozen', PROBE_PATH)
  if (r.allowTest) genArgs.push('--allow-cmd', r.allowTest)
  for (const g of pol.denyPath) genArgs.push('--deny-path', g)
  for (const c of pol.denyCmd) genArgs.push('--deny-cmd', c)
  for (const t of pol.denyTool) genArgs.push('--deny-tool', t)
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

  const announce = (prefix) => {
    console.error(`>>> deepseek-run: ${prefix}  model: ${modelId}  dir: ${r.dir}`)
    console.error(`>>> repo: ${repoRoot}`)
    if (seam.overlayPath) console.error(`>>> seam: ${seam.overlayPath} (approved)`)
    if (seam.policyPath) console.error(`>>> seam: ${seam.policyPath}`)
    if (patchFiles.length) console.error(`>>> overlays: ${patchFiles.join(' ')}`)
    console.error(`>>> denied: ${pol.denyPath.length} paths, ${pol.denyCmd.length} commands, ${pol.denyTool.length} tools (see ${join(rundir, 'policy.json')})`)
    if (r.allowTool.length) console.error(`>>> OPERATOR LIFTED: ${r.allowTool.join(' ')}`)
    if (r.frozen.length) console.error(`>>> frozen: ${r.frozen.join(' ')}`)
    if (r.allowTest) console.error(`>>> only permitted command: ${r.allowTest}`)
  }

  if (r.dry) {
    announce('DRY RUN (backend: dsh)')
    console.error(`>>> artifacts: ${rundir}`)
    process.exit(0)
  }

  // -------------------------------------------------------------------------
  // The canary. Ask the guard to block something it MUST block, BEFORE spending
  // anything. A guard that cannot execute exits non-2, which the harness treats
  // as non-blocking, so the run would look guarded and be entirely unguarded.
  // Probe the DEPLOYED copy at its deployed path -- that is the file the
  // harness will actually invoke. There is no flag to skip this.
  // -------------------------------------------------------------------------
  const deployedGuard = join(rundir, 'delegation-guard.mjs')
  const canary = await runCanary({ guardPath: deployedGuard, runDir: rundir })
  if (!canary.ok) {
    console.error(`deepseek-run: ABORTED -- ${canary.detail}`)
    console.error('Nothing has been spent.')
    process.exit(2)
  }
  console.error('>>> canary: the guard blocked its probe; the boundary is live')

  // `command -v dsh`: spawn failure means it is not on PATH.
  if (spawnSync('dsh', ['--version'], { stdio: 'ignore' }).error) {
    console.error('deepseek-run: dsh not on PATH. Install it with:')
    console.error('  npm i -g @deepseek-ai/dsh   (then symlink it onto PATH if needed)')
    console.error('Or fall back with: --backend claude-code')
    process.exit(3)
  }

  announce('backend: dsh')

  // The Node guard reads policy.json beside itself, so NO DELEGATION_* exports
  // are needed -- which also takes shell quoting out of the security path.
  //
  // `env -u DEEPSEEK_API_KEY` is load-bearing, not hygiene: the inherited
  // process environment ALWAYS wins over $DSH_HOME/.credentials.yaml, so an
  // exported key would silently bypass the managed store.
  const env = { ...process.env }
  delete env.DEEPSEEK_API_KEY
  const res = spawnSync('dsh', ['--profile', 'headless', ...patchArgs, r.prompt], {
    cwd: r.dir, env, stdio: ['ignore', 'inherit', 'inherit'],
  })

  reportTree(r)
  runReport(r.dir)
  process.exit(res.status ?? 1)
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

  // ANTHROPIC_API_KEY is CLEARED, not merely overridden: an inherited Anthropic
  // key would silently bill Anthropic for work meant to run on DeepSeek, and
  // the failure is a surprising invoice rather than an error.
  const child = { ...process.env, ...env }
  delete child.ANTHROPIC_API_KEY

  const args = ['-p', r.prompt, '--add-dir', r.dir, '--permission-mode', perm,
    '--max-turns', String(r.turns), '--output-format', 'json']
  if (r.allow.length) args.push('--allowedTools', r.allow.join(','))

  const res = spawnSync('claude', args, { cwd: r.dir, env: child, stdio: ['ignore', 'inherit', 'inherit'] })
  if (res.error) {
    console.error('deepseek-run: claude not on PATH; install Claude Code or use --backend dsh')
    process.exit(3)
  }

  reportTree(r)
  process.exit(res.status ?? 1)
}

async function main (argv) {
  let r
  try {
    r = resolveRun(argv)
  } catch (e) {
    if (e instanceof Help) { process.stdout.write(USAGE); process.exit(0) }
    if (e instanceof UsageError) { process.stderr.write(`deepseek-run: ${e.message}\n`); process.exit(2) }
    throw e
  }
  // --approve-overlay is a dsh-seam operation; it has no meaning for the
  // claude-code backend, which mounts no overlays.
  if (r.backend === 'dsh') await runDsh(r)
  else runClaudeCode(r)
}

// Runnable as a script, importable as a module (resolveRun for unit tests).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2))
}

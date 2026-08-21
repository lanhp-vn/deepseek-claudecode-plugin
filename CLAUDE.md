# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A Claude Code plugin marketplace holding one plugin, `dsh`. The plugin does not
implement a model — it *wraps* the DeepSeek Harness (`dsh`) CLI so Claude can
plan and verify while DeepSeek V4 writes code inside a sandbox, under a
`PreToolUse` guard that refuses to start unless it can prove it is working.

Two different things are called `dsh`. `/dsh:setup` and `/dsh:run` (with the
colon) are this plugin's commands. Bare `dsh` is the harness CLI, installed
separately via npm. `README.md` covers install and the trust model in depth;
this file covers working *on* the code.

## Commands

```bash
# Full suite (both script directories). This is the check before any change.
node --test plugins/dsh/scripts/*.test.mjs plugins/dsh/skills/_delegation/scripts/*.test.mjs

# One file, or one test by name
node --test plugins/dsh/scripts/deepseek-run.test.mjs
node --test --test-name-pattern "canary" plugins/dsh/scripts/canary.test.mjs

# Does the local setup work? Reports node/platform, shell, hook bridge, key,
# models, balance. Writes nothing. Reach for this first when a run fails oddly.
node plugins/dsh/scripts/setup-deepseek.mjs --verify-only

# Compose a run's artifacts and stop, spending nothing. The fastest way to see
# what a flag actually produces.
node plugins/dsh/scripts/deepseek-run.mjs -C <repo> --dry-run --dry-run-dir <out> "task"

# Vendored-prose drift check (see "The _delegation boundary")
UBUNTU_SETUP=~/Documents/system-settings node scripts/vendor-delegation.mjs --check

# The harness source, for maintainers only; not needed to use the plugin
git submodule update --init references/deepseek-harness
```

The differential tests (~50 cases) skip unless `BASH_GUARD` and `NODE_GUARD`
point at the two guard implementations, and skip unconditionally on Windows
because there is no bash reference there. A large skip count is normal.

## Architecture

Two layers, and the split matters: `plugins/dsh/scripts/` is the **wrapper**
that composes a run, and `plugins/dsh/skills/_delegation/scripts/` is the
**guard** that enforces it from inside the delegate's process.

`deepseek-run.mjs` is the entry point. One run walks these in order:

| Step | Module | What it decides |
|---|---|---|
| 1 | `seam.mjs` | Finds `<repo>/.deepseek/{overlay,policy}.yml`, loads `~/.deepseek/machine.yml`, resolves `${machine.*}`. A referenced-but-unset key is a hard failure naming the key — never an empty string. |
| 2 | `policy.mjs` | Unions the repo deny set with the permanent floor. A committed file can only ADD denies; `allowTool` in a repo file is not read at all. |
| 3 | `approval.mjs` | Hashes the overlay's raw bytes (pre-substitution, so machine-independent) keyed by absolute path. Unapproved means the run refuses and prints what would be mounted. |
| 4 | `gen-hooks.mjs` | Writes `<workspace>/.delegation-run/{hooks.json,policy.json}` and copies the guard **inside the workspace root**. |
| 5 | `canary.mjs` | Asks the deployed guard to block something it must block. Aborts before spending if it does not. |
| 6 | backend | `dsh --profile headless` (default), or Claude Code aimed at DeepSeek's Anthropic-compatible endpoint (`--backend claude-code`, POSIX-only). |
| 7 | `session-report.mjs` | Reads the durable session log: every tool call, every guard decision, token totals. |

### Invariants that explain the shape of the code

**The harness fails OPEN.** Only exit 2 blocks a tool call; any other exit is a
non-blocking error and the call is **allowed**. So a guard that cannot execute
makes a run look guarded while being unguarded. That single fact is why the
guard is copied inside the workspace (step 4) and why the canary exists (step 5).
There is no flag to skip the canary and none should be added.

**A tool missing from the matcher is never hooked.** `hooks.json` carries one
`PreToolUse` matcher; the guard's `switch` handles tool names. If the two
disagree, the guard's handling of that tool is dead code and the rule it
enforces is silently off. This pair has drifted three times (`apply_patch`,
`pwsh`, `NotebookEdit`). `hooks-matcher.test.mjs` now asserts the agreement.

**The guard is a speed bump, not a boundary.** Whitelisting any command that
runs project code (`pytest` reading `conftest.py`, `npm test`, `make`) grants
arbitrary code execution by construction. A delegate has used exactly that route
to rewrite a frozen test and then delete the helper. `git diff -- <frozen>` is
the check that actually holds; the guard buys cost and an audit trail.

**The sandbox confines writes only.** Reads and network are not confined.

### The `_delegation` boundary

`plugins/dsh/skills/_delegation/` is vendored from an upstream dotfiles repo
(`VENDOR-MANIFEST.json` records the commit and hashes). The two halves are
checked differently on purpose:

- **prose** (`README.md`, `references/*.md`) is a verbatim copy, checked by
  SHA-256. Do not edit these here — edit upstream and re-vendor, or
  `vendor-delegation.mjs --check` fails.
- **scripts** are Node *ports* of bash originals, so a hash cannot compare them.
  They are checked behaviourally by `differential.test.mjs`, which feeds both
  implementations the same payloads and fails if they ever decide differently.

### No runtime dependencies, deliberately

Claude Code does not install a plugin's node dependencies into its cache
(verified 2026-08-20: `import('yaml')` from the cache fails). Hence
`yaml-lite.mjs` instead of a YAML library, and the guard imports only `node:`
builtins — a missing `node_modules` must never be able to disable a security
boundary.

## Platform hazards

Windows is a primary target and the reason most of this code is Node. Every item
below was a real, shipped bug; none is theoretical.

- **dsh runs command hooks through `ctx.shell`, which is PowerShell on Windows.**
  A `.sh` hook cannot execute there, exits non-2, and is treated as
  non-blocking — so every protection was off, on every Windows run, while the
  config looked perfect. Never emit a shell-script hook.
- **PowerShell does not adopt a native command's exit code as its own.** `node
  guard.mjs` exiting 2 leaves the hook process exiting 1, which the protocol
  treats as non-blocking, so **every block becomes an allow**. The generated
  command must end `; if ($LASTEXITCODE -ne 0) { exit 2 }` on win32 — `exit 2`,
  not `exit $LASTEXITCODE`, so a crash (1) or a missing interpreter (`$null`)
  blocks too. Never emit that suffix for a POSIX shell, where `$LASTEXITCODE` is
  empty and `exit ` exits 0 — the same fail-open in the other direction.
- **A security probe must cross every layer production crosses.** The canary
  spawned the guard directly and so certified a path the harness never uses; it
  missed both the matcher gap and the exit-code collapse. It now runs the real
  command string from `hooks.json` through the real shell, and probes a call that
  must be allowed as well as one that must be blocked — because a fail-closed
  hook form makes a *broken* guard pass a block-only probe.
- **`spawnSync` on a bare npm-installed CLI name is ENOENT on Windows.** npm
  installs `foo`, `foo.cmd` and `foo.ps1` but no `foo.exe`, and Node does no
  PATHEXT resolution without `shell: true`; naming the `.cmd` directly is EINVAL
  (Node's CVE-2024-27980 mitigation). Resolve the package's `bin` and spawn
  `process.execPath` instead — see `resolveDsh()`. Do **not** reach for
  `shell: true` when a prompt or brief is one of the argv elements: cmd.exe will
  eat the `&&`, `|` and backticks that a good brief legitimately contains.
- **A Windows path in generated YAML must be single-quoted.** In a
  double-quoted scalar a backslash opens an escape, so a drive path becomes
  "expected hexadecimal character" and the harness refuses the patch before the
  run starts. Unquoted survives backslashes but not a `#` or `: ` in the path.
- **`new URL(...).pathname` yields a leading slash before the drive letter**, so
  it resolves against the cwd and doubles the drive. Use `fileURLToPath`.
- **`statSync().mode & 0o111` is 0 for every file on NTFS.** Never gate a check
  on the exec bit; the guard is invoked with the interpreter named explicitly on
  every platform, so the bit is vestigial anyway.
- **A raw substring search against JSON breaks on escaped separators.** Compare
  the encoded form too, or parse. On POSIX this silently works, so only Windows
  sees the failure.
- **dsh's shell tool is `pwsh` on Windows and `bash` elsewhere.** Any matcher or
  switch over shell tools must list both.
- **`node --test` cannot run under the dsh sandbox**: it spawns a child process
  per test file and the sandbox denies it with EPERM. Briefs should whitelist a
  spawn-free command (`node tests/x.test.mjs` runs in-process).
- **Session logs are concatenated zstd frames.** Node's `zstdDecompressSync` and
  its stream decompressor both stop after the first frame, which reads as a
  near-empty log. Use `decompressFrames` from `session-report.mjs`.

## Conventions

- Security-relevant comments carry a **date and a measurement** ("Measured
  2026-08-15: ..."). Preserve that style; it is how a claim here is told apart
  from a guess about a fast-moving preview API.
- Tests are mutation-checked, not merely observed green: break the product,
  confirm the test fails and names the right thing, restore. A test that cannot
  fail is worse than no test, because it is trusted.
- Source files are CRLF.
- `~/.deepseek/machine.yml` is per-machine by definition and must never be
  committed.
- Quote globs in the `.deepseek/*.yml` files. `- *.enc` is a YAML *alias* and a
  real parser rejects it; write `- "*.enc"`.

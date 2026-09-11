# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A Claude Code plugin marketplace holding one plugin, `dsh`. The plugin does not
implement a model — it *wraps* the DeepSeek Harness (`dsh`) CLI so Claude can
plan and verify while DeepSeek V4 writes code inside a sandbox, under a
`PreToolUse` guard that refuses to start unless it can prove it is working.

Two different things are called `dsh`. `/dsh:setup`, `/dsh:run`, `/dsh:test`,
`/dsh:update` and `/dsh:tools-check` (with the colon) are this plugin's
commands and skills. Bare `dsh` is the harness CLI, installed separately via
npm.

### Which doc says what

Keep the split when editing. Prose that explains *why* the code is shaped the
way it is belongs here and nowhere else; a reader who only wants to use the
plugin should never have to read a fail-open post-mortem to install it.

| File | Audience | Holds |
|---|---|---|
| `README.md` | someone installing or using it | quickstart, the five commands, the seam, what a delegate can never do. Tables and diagrams; no rationale |
| `ONBOARDING.md` | a teammate on a new machine | the step-by-step walkthrough, and the paste-in prompt that installs and configures it |
| `CLAUDE.md` (this) | someone changing the code | architecture, invariants, platform hazards, every measured post-mortem |
| `plugins/dsh/skills/*/SKILL.md` | Claude, at runtime | how to *drive* one command; each is the reference for its own flags and failure table |

`README.md` and `ONBOARDING.md` overlap on purpose — a quickstart and a
walkthrough each have to stand alone — and the two facts neither may ever omit
are that the hook bridge is mandatory and that a repo policy can only ever ADD
denies. What must *not* be duplicated is **rationale**: a post-mortem, a measured
date, a "why it is shaped this way" belongs here alone, so a finding has one
place to be corrected. The permanent deny floor is *defined* in `policy.mjs` and
*documented* in `README.md` — change the two together.

Nothing outside `plugins/dsh/` reaches a user at runtime: the plugin cache holds
`commands/`, `examples/`, `overlays/`, `scripts/` and `skills/` and nothing else,
so `${CLAUDE_PLUGIN_ROOT}/README.md` and `.../CLAUDE.md` do not exist. A
`SKILL.md` must never point at one.

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

# Does the whole thing still WORK? The above plus the generated guard, the
# canary, and one real delegation briefed to attempt two refused calls. Costs
# about a cent and is the only check that proves the block path. Run it after
# any change to the guard, the generator or the wrapper.
node plugins/dsh/scripts/dsh-doctor.mjs
node plugins/dsh/scripts/dsh-doctor.mjs --no-spend   # static tier only

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

**A probe only certifies the shape it sends.** The canary now fires three: a
frozen write spelled with `/`, the same file spelled with `\`, and a call that
must be ALLOWED. Each was added after a live run found something the previous
set walked past — a direct spawn that skipped the shell, a fail-closed hook form
that made "blocks everything" look healthy, and a path matcher that only spoke
`/`. When the doctor's live tier finds a new one, add a probe rather than only a
test.

**Safe but useless is still a failure.** The Windows hook form is fail-closed, so
a guard that is missing, unparseable or has no `policy.json` blocks *everything* —
and used to pass a block-only canary while being non-functional. It now aborts:
such a run refuses every tool call, so you pay for a delegate that can do
nothing. This is why the canary probes an ALLOW as well as a BLOCK; a check that
cannot tell "holds the line" from "bricked" measures neither.

**One implementation, on every platform.** A `.ps1` twin of the guard was
considered and rejected: two implementations of a security boundary drift, and a
guard that disagrees with itself across platforms is worse than an absent one
because it still gets trusted. Everything is Node, which adds no prerequisite —
`dsh` *is* Node. `differential.test.mjs` holds the one remaining pair (the bash
original upstream and this port) to the same decisions for exactly that reason.

**`--no-overlay` drops capability, never denies.** It bypasses the approval gate
because it mounts nothing out of the repo's `overlay.yml` and so acquires no
capability to consent to; the floor and the repo's `policy.yml` still apply. It
also drops the plugin's own `overlays/00-base.yml`, whose only content disables
the billed session-title request — so in a repo with *no* `overlay.yml` the flag
mounts exactly the same tools and costs one extra request per run (measured
2026-08-21). It is for skipping a repo's overlay on a prose task, not a habit.

**Caller-supplied values reach `gen-hooks` as `--opt=value`.** A repo's deny
entry may legitimately start with `-` (`-m integration`), and the space-separated
form makes `parseArgs` reject it, killing the run with an error that names the
wrong culprit.

**A tool missing from the matcher is never hooked.** `hooks.json` carries one
`PreToolUse` matcher; the guard's `switch` handles tool names. If the two
disagree, the guard's handling of that tool is dead code and the rule it
enforces is silently off. This pair has drifted three times (`apply_patch`,
`pwsh`, `NotebookEdit`). Measured 2026-08-20, with the Node guard already in
place: the matcher listed only `bash`/`Bash` while dsh names its shell tool
`pwsh` on Windows, so a hook that existed, ran, and passed its own canary never
fired for a single shell call — 6 tool calls, 3 hook invocations, `--allow-test`
enforcing nothing. `hooks-matcher.test.mjs` now asserts the agreement, and the
count disagreement is what `matcher coverage` in the run report looks for.

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

- **prose** — `references/routing.md`, `references/briefing.md`,
  `references/verification.md`, and *only* those three — is a verbatim copy,
  checked by SHA-256. Do not edit them here; edit upstream and re-vendor, or
  `vendor-delegation.mjs --check` fails.
- **scripts** are Node *ports* of bash originals, so a hash cannot compare them.
  They are checked behaviourally by `differential.test.mjs`, which feeds both
  implementations the same payloads and fails if they ever decide differently.
- **`_delegation/README.md` is plugin-authored, not vendored** — the `PROSE`
  list in `vendor-delegation.mjs` deliberately excludes it. Upstream's copy
  documents a `delegation-guard.sh`, and a verbatim copy would tell a reader the
  boundary is a shell script, which is the exact thing that fails open on
  Windows. Edit it here.

### No runtime dependencies, deliberately

Claude Code does not install a plugin's node dependencies into its cache
(verified 2026-08-20: `import('yaml')` from the cache fails). Hence
`yaml-lite.mjs` instead of a YAML library, and the guard imports only `node:`
builtins — a missing `node_modules` must never be able to disable a security
boundary.

## Platform hazards

Windows is a primary target and the reason most of this code is Node. Every item
below was a real, shipped bug; none is theoretical.

- **A path arriving with backslashes matches nothing.** Every matcher in the
  guard speaks `/`: `pathGlobToRe` uses `[^/]`, `pathDenied` splits on `/`, the
  frozen rule tests `endsWith('/' + basename)`. dsh's `write` tool sends an
  ABSOLUTE `file_path`, so on Windows a frozen `contract.txt` arrived as
  `C:\...\contract.txt` and the guard returned exit 0 — the frozen rule and
  every `denyPath` rule were silently off for absolute paths. Measured
  2026-08-21 by `dsh-doctor`'s first live run; the 2026-08-20 check passed only
  because that delegate happened to send a relative path. Paths are normalised
  once at the boundary (`slash()`), never per matcher; `guard-paths.test.mjs`
  pins it. Anything that compares *or reads* a path must go through that
  boundary — the class recurred harmlessly on 2026-08-21 in
  `session-report.mjs`, where the report heading split a log path on `/` to name
  the session directory and printed `(undefined)` on every Windows run.
  Cosmetic there, silently unguarded in the guard; same mistake.
  `session-report.test.mjs` pins that one.
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

## Upstream hazards

**The model catalogue moves faster than the CLI, and every id this wrapper ever
wrote is now dead or legacy.** Measured 2026-09-10 from
`https://api-docs.deepseek.com/updates/` and the pricing page: V4.1-Flash
shipped that day as `deepseek-flash`; `deepseek-v4-pro` retires 2026-09-14, at
which point its requests route to V4.1-Flash and bill at the flash price;
`deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are legacy aliases
"temporarily routed" to the same model. `deepseek-chat` and `deepseek-reasoner`
had already gone on 2026-07-24. That is **four** id changes in under three
months, so the model id is a fast-moving upstream in its own right and belongs
in the `/dsh:update` sweep next to the CLI.

Two consequences shaped the code:

- **One constant, `MODEL_ID` in `deepseek-run.mjs`, for both backends.** It used
  to be two ternaries — a plain id for the headless patch and a `[1m]`-suffixed
  one for claude-code — which is the same paired-value drift hazard as the
  matcher/switch pair. The `[1m]` suffix is gone: the 2026-09-10 pricing page
  lists no separate 1M variant id, gives `deepseek-flash` a 1M context and 384K
  max output on its own, and DeepSeek's Anthropic-compatibility guide spells it
  bare. A suffix naming nothing would have been a silently-wrong model id on the
  fallback backend — the one reached for precisely when the default is broken.
- **`-m` refuses an unsupported value instead of remapping it.** Remapping
  `-m pro` to flash would have been free and invisible, which is exactly the
  silent-acceptance class this repo keeps getting bitten by; the run would have
  ignored an explicit flag and still reported success. The pro-only
  `-e high|max` check was deleted with the model rather than re-pointed at
  flash: whether flash rejects, honours or silently swallows an effort value is
  **not** documented, and the old check's whole reason for existing was that pro
  accepted `low` silently (verified live 2026-08-09). Re-asserting an unverified
  constraint would have been a guess wearing a measurement's clothes. `-e` is
  therefore unverified against V4.1-Flash — read the session log, not the flag.

The harness CLI itself is a moving preview dependency (`/dsh:update`'s own
warning: "a new rc can move the headless command line, the patch-row ids the
wrapper writes, or the session-log format"). These are not platform-specific;
they were found by upgrading `dsh` in place, not by changing anything here.

- **Two npm packages must move together, and only one of them has a `latest`
  tag you can trust.** The hook bridge (`@deepseek-ai/dsh-hooks-claude-code`,
  with its `dsh-hook-protocol` peer) reaches into harness internals, so it is
  version-locked to the CLI — its `peerDependencies` name the CLI's own version
  family. Upgrade one without the other and every tool call dies.

  Measured 2026-09-04, re-measured 2026-09-10, and **misdiagnosed both times**:
  bumping the CLI from `0.1.0-rc.7` to `0.1.2-rc.1` (later `0.1.5-rc.1`) made
  every tool call in a live delegation fail with an internal
  `agent.session.events is not iterable`, and — far worse — the `PreToolUse`
  hook never fired at all (0 guard decisions across 6 matched calls), so a
  briefed refusal would have been delivered as a silent ALLOW. That was read as
  a CLI regression and answered by pinning back to `0.1.1-rc.2`.

  It was not a CLI regression. Root-caused 2026-09-10: the failing frame is in
  the **bridge**, which had sat at `0.0.1-rc.5` throughout. Its `lastTurn()` did
  `[...agent.session.events]`; the newer core replaced that field with session
  projections (`ctx.sessionProjections.stateOf(session, 'turnBoundary')`, plus a
  new `@deepseek-ai/dsh-session-projection` peer), and spreading a non-iterable
  throws that exact message. Because `lastTurn` runs while building the
  PreToolUse payload, one crash caused both symptoms at once: the hook never
  fired AND the tool call failed. Moving the bridge in lockstep fixes it —
  `0.1.5-rc.2` passes every doctor check, block path included.

  **Why it stayed hidden: the plugin packages publish a `0.1.x` line, but
  upstream never moved their `latest` dist-tag off `0.0.1-rc.*`** (checked
  2026-09-10, all nine). So the unversioned
  `dsh plugin --profile headless add <pkg>` that README, ONBOARDING and
  `/dsh:update` all printed resolves to the ANCIENT line and can never produce a
  matched set against a bumped CLI. The skew was structurally guaranteed, and
  nothing warned — pnpm's "unmet peer" line is routine noise in this tree, which
  is exactly why `/dsh:update` tells you not to read it as a reason to upgrade.
  Every install command in this repo now pins an explicit version, and
  `dsh-doctor` fails a `profile lockstep` check when the bridge's `major.minor`
  differs from the CLI's.

  The general lesson outlived its wrong first answer: static checks passing
  right after a bump is not evidence the install is safe to delegate against —
  only a live doctor run proves that. What changed is the remedy. Pinning the
  CLI *backwards* treated a symptom and cost five weeks on a stale harness; the
  fix was to move both halves forward together. Before concluding "the whole
  release line is bad", find out which package the failing frame belongs to.

- **The session log filename carries a format version, and it moved.**
  `0.1.1-rc.2` wrote `session.jsonl.zstd`; `0.1.5-rc.2` writes
  `session.v3.jsonl.zstd` (measured 2026-09-10). `findNewestLog` compared the
  basename exactly, so the live doctor found no log for its own run and fell
  back to the newest match on disk — a healthy run from an **unrelated
  project** — then printed that session's tool calls and guard decisions under a
  run they did not belong to, reporting "no guard was mounted on this run" while
  the guard had in fact blocked twice. Only the `session log` check caught it: a
  stale log is indistinguishable from a fresh one by content alone, and the
  giveaway is a session id or cwd slug that does not match the run. The match is
  now version-agnostic (`/^session(\..+)?\.jsonl\.zstd$/`) and pinned by tests
  in `session-report.test.mjs`. The frames themselves still decode unchanged
  with `decompressFrames`.

- **A version bump can migrate `$DSH_HOME/.credentials.yaml` to a shape an
  older CLI cannot read, and a downgrade does not migrate it back.** Also
  measured 2026-09-04: `0.1.2-rc.1` rewrote the file from the flat mapping
  `dsh-credentials-local` requires (verified 2026-08-15) into a nested
  `version`/`refs` document. Rolling the CLI back to `0.1.0-rc.7` afterward
  made `dsh` fail to *boot* — a raw `TypeError: ... "refs" ... must be a
  string` stack trace, not a graceful error, because the crash happens inside
  `dsh`'s own process before the wrapper runs anything. The fix is to hand-edit
  the file back to a flat mapping (`DEEPSEEK_API_KEY: sk-...`, no wrapper keys).
  `setup-deepseek.mjs --dsh` now refuses to touch a non-flat file rather than
  silently producing a hybrid that still fails to parse — see
  `mergeFlatCredential` and its tests in `setup.test.mjs`. Back up
  `$DSH_HOME/.credentials.yaml` (or note its exact contents) before bumping the
  harness CLI, precisely because a downgrade is not guaranteed to be clean.

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

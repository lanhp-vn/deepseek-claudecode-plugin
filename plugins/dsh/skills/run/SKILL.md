---
name: run
description: >-
  Use when the user wants Claude to plan, specify and verify while DeepSeek V4
  writes the implementation, the cheap-implementer half of the codex-invoke
  pattern. Trigger whenever the user says "deepseek", "dsh", "/dsh:run", "use
  deepseek to build/implement/write", "delegate to deepseek", "hand this to
  deepseek", "cheap implementer", "do this on deepseek instead", or asks to
  implement a written spec/plan/task-list on a budget. Also use when the user
  asks to set up, install, wire up or troubleshoot a DeepSeek API key or the
  DeepSeek Harness (dsh), or asks what DeepSeek costs, which DeepSeek model to
  use, whether DeepSeek supports images or vision, or how to point a coding
  agent at DeepSeek. Prefer this over codex-invoke when the task is
  well-specified, mechanical or high-volume and a test defines "done". Do NOT
  trigger for code exploration, for subtle work where being wrong is expensive,
  or when the user has not asked to involve DeepSeek. For looking something up
  on the web -- docs, changelogs, versions, GitHub -- use /dsh:research instead:
  it is the same delegate pointed at reading rather than writing.
---

# `/dsh:run` — you specify, DeepSeek implements

You are the **tech lead**. DeepSeek is a **cheap, capable implementer**. You
plan, write the tests that define "done", hand over a brief, then review and run
what comes back.

Three shared documents carry the discipline common to all the delegation
skills. Read them rather than reconstructing them here:

- `../_delegation/references/routing.md` — which delegate gets this task
- `../_delegation/references/briefing.md` — the brief skeleton and the frozen-tests rule
- `../_delegation/references/verification.md` — the gate

This file covers what is different about DeepSeek: the two backends, the guard,
per-project capability, keeping the bill down, and the sharp edges of a
per-token API.

## Running one

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/deepseek-run.mjs -C "$PWD" \
  --frozen tests/test_importer.py \
  --allow-test "uv run --with pytest python -m pytest" \
  -f /tmp/brief.md
```

**No `-m`: there is one model.** `deepseek-run.mjs` writes `deepseek-flash`
(V4.1-Flash) into every run's patch. `-m flash` is accepted and does nothing;
**any other value is refused with exit 2** rather than quietly remapped. If you
have a habit of typing `-m pro`, drop it — see "One model" below for why.

`${CLAUDE_PLUGIN_ROOT}` is not set in an ordinary shell, so when running these
through Bash resolve the cache path instead:
`~/.claude/plugins/cache/dsh/dsh/*/scripts/`.

Setup, once per machine: `/dsh:setup`. The key is never printed — every
message shows a masked fingerprint.

**A bare `dsh` install cannot mount the guard.** The wrapper inserts a row
naming `@deepseek-ai/dsh-hooks-claude-code`, and dsh exits 1 at boot with
`Cannot find package` when it is absent — every delegation fails, not some. Once
per machine:

```bash
dsh plugin --profile headless add @deepseek-ai/dsh-hooks-claude-code@0.1.5-rc.2 \
  @deepseek-ai/dsh-hook-protocol@0.1.5-rc.2 @deepseek-ai/dsh-session-projection@0.1.5-rc.2
```

`--verify-only` checks this and names what is missing.

| `--backend` | What runs | Use it when |
|---|---|---|
| `dsh` *(default)* | DeepSeek Harness, `dsh --profile headless` | Normally. Real harness, filesystem sandbox, durable session log, working `PreToolUse` guard |
| `claude-code` | Claude Code pointed at `api.deepseek.com/anthropic` | `dsh` broke, or it is not installed. **Linux/macOS only** — it has not been verified on Windows |

**`dsh` is a developer preview that says "THERE WILL BE COMPATIBILITY-BREAKING
CHANGES".** That is exactly why the second backend still exists. Do not delete
it because the default works today.

| Flag | Meaning |
|---|---|
| `-C <dir>` | repo to work in; also the sandbox's workspace root |
| `-m flash` | model. **Pass nothing** — `deepseek-flash` is the only model and the default. `-m flash` is a no-op; anything else exits 2 |
| `--frozen <path>` | repeatable; these files cannot be written (see the guard) |
| `--allow-test "<cmd>"` | the only shell command the delegate may run |
| `-f <file>` | brief from a file; avoids shell-quoting fights |
| `--dry-run` | compose the run artifacts and stop, without spending anything |
| `--overlay <file>` | repeatable; an extra cordis patch layer |
| `--no-overlay` | skip `00-base.yml` **and** the repo overlay. Only pays off when the repo HAS an overlay to skip — see below |
| `--deny-path <glob>` | repeatable; a path the delegate may not read or write |
| `--deny-cmd <pattern>` | repeatable; a command it may not run, in bash OR a PTY |
| `--deny-tool <name>` | repeatable; a tool it may not call — the only rule reaching MCP |
| `--allow-tool <name>` | repeatable; **lift** one deny for this run. The only escape hatch |
| `--approve-overlay` | review and approve this repo's `.deepseek/overlay.yml`, then exit |

## Per-project capability: the `.deepseek/` seam

A repository declares what its delegations may use, and the deny set that bounds
it, in two committed files at its root:

```
<repo>/.deepseek/overlay.yml   what the delegate may USE  (a dsh patch layer)
<repo>/.deepseek/policy.yml    what it may NOT do         (deny sets)
~/.deepseek/machine.yml        this machine's paths       (never committed)
```

Both are optional; a repository with no `.deepseek/` gets the base composition
and the permanent floor, which is a working configuration and not a degraded
one. Copy a starting point from `${CLAUDE_PLUGIN_ROOT}/examples/`.

This is a cost decision as much as a tidiness one: **an MCP server's tool
schemas are paid on every request** in the prompt prefix, so a markdown job must
not carry the code graph a refactor needs. Pass `--no-overlay` for prose work in
a repo that HAS an overlay.

**`--no-overlay` costs you something in a repo that has none.** Measured
2026-08-21 with two dry runs: it also drops `overlays/00-base.yml`, whose entire
content disables `session-title-llm` — a billed LLM request issued on every run
purely to name a session nothing reads. In a repo with no `.deepseek/overlay.yml`
the flag therefore mounts exactly the same tools either way and buys back one
pointless request per run. Reach for it to skip a *language server*, not as
generic prose hygiene.

**Machine-specific values.** An interpreter path or a board address would make
`overlay.yml` per-machine and therefore uncommittable, so it writes
`${machine.python}` and the value resolves from `~/.deepseek/machine.yml`. A key
referenced but not set is a **hard failure naming the key**, before anything is
spent — never an empty string, which would mount a server with a blank command
and fail silently.

### Two rules that make a committed file safe to read

**A repo policy can only ADD denies.** `policy.yml` is unioned with a permanent
floor and can never subtract from it; an `allowTool` key in a repo file is not
read at all. Otherwise "clone this repo and delegate in it" would be a way to
hand a delegate capability the operator never granted. The only escape hatch is
`--allow-tool`, which lives in a hand and in the session log, never in a file.

The floor denies the gitnexus graph mutators and `cordis_*` (which executes
dynamic packages in the live runtime), reads of `.env*`, `*.key`, `*.pem`,
`credentials/**`, `**/.ssh/**` and `.git/config`, and `git push` /
`git reset --hard` / `git clean -fdx`.

**Capability never arrives silently with a clone.** The first time a given
`overlay.yml` is seen at a given path, the run REFUSES and prints what the file
would mount. Approve it with `--approve-overlay` after reading it. The hash is
over the raw bytes before substitution, so it is machine-independent, and it is
keyed by absolute path — two clones are two decisions. Editing the overlay
re-arms the gate.

`--no-overlay` skips the gate along with the overlay, because a file that is
never mounted grants nothing to consent to. The deny set is unaffected: a
`--no-overlay` run still carries the floor and the repo's `policy.yml`. So the
cheap prose path stays open on a repo whose overlay was just edited, instead of
demanding approval for a language server it will not load.

**Globs in these files must be quoted.** `- *.enc` is an *alias* in YAML and a
real parser rejects it; write `- "*.enc"`.

## The guard, and exactly how far it goes

`--frozen` and `--allow-test` are enforced by a generated `hooks.json` that the
harness runs before every tool call. A write to a frozen path is refused; a
command that is not the whitelisted one is refused; every attempt lands in the
session log.

**It blocks the direct route. It is not a boundary.**

Measured 2026-08-15, on a delegate given a deliberately unsatisfiable frozen
contract: the guard refused its `edit`, the refusal is in the log — and the
delegate then wrote a `conftest.py`, let the whitelisted `pytest` command
execute it, had *that* code rewrite the frozen test, and deleted the helper
afterwards. It disclosed this in its summary. It might not have.

`git diff -- tests/` caught it in one command.

Whitelisting anything that runs project code — `pytest` reading `conftest.py`,
`npm test` running scripts, `make` — grants arbitrary code execution by
construction. So the guard buys you a raised cost and an audit trail, and
**the diff is still what holds**. Never skip step 3 of the verification gate
because the guard was on.

### It used to fail OPEN. Now it fails closed.

Only exit 2 blocks. A guard that cannot execute exits 127, which the harness
treats as a non-blocking error and **allows the call** — a run can look guarded
in its config and be entirely unguarded. This happened here on 2026-08-15, and
the delegate rewrote a frozen test unopposed while the config looked perfect.

Two things fix it, and neither has an override:

- the generator copies the guard **inside** the workspace root, so it is
  reachable; and
- before anything is spent, a **canary** asks the guard to block something it
  must block. If it does not, the run aborts with `Nothing has been spent.`

**Never add a flag that skips the canary.** It is the check that would have
caught both the 2026-08-15 incident and the Windows fail-open below.

**But know what the canary proves, and what it recently did not.** Two failures
on 2026-08-20 both slipped past it and both are now fixed:

- it spawned `node <guard>` **directly**, while dsh runs hooks through
  PowerShell, which does not adopt a native exit code. The guard exited 2, the
  hook exited 1, every block became an allow — and the canary saw none of it,
  because its own spawn skipped the shell. It now runs the exact command from the
  generated `hooks.json`, through the shell dsh will use.
- it probed only a call that must be **blocked**. Since the Windows form is
  fail-closed, a broken guard blocks everything and passes such a probe while
  doing nothing useful. It now also probes a call that must be **allowed**, so a
  guard that cannot discriminate aborts the run instead of starting it.

A knock-on: a guard with no `policy.json` used to be reported as a live boundary
(it fails closed). It now aborts — safe but useless is still a failure, because
it refuses every tool call and you pay for the run regardless.

Independent of the canary, the cheap cross-check is in the run report: compare
the guard-decision count against the tool-call count. If calls are not being
hooked, those two numbers disagree.

### The Windows fail-open this plugin exists to fix

dsh runs command hooks through `ctx.shell`, which is **PowerShell on Windows**.
The bash generator emitted a `.sh` hook, PowerShell cannot execute it, the hook
exited non-2, and the protocol treats that as non-blocking. So on Windows the
config looked correct and **every protection was off, on every run**. Everything
here is Node for that reason, and the guard imports only `node:` builtins — a
missing `node_modules` must never be able to disable a security boundary.

It then happened a second time, same class, same platform, with the Node guard
in place. dsh names its shell tool `pwsh` on Windows and `bash` elsewhere, and
the generated matcher listed only `bash`/`Bash` — so a hook that existed, ran,
and passed its own canary never fired for a single shell call. Measured
2026-08-20: 6 tool calls against 3 hook invocations, and a delegate running a
command that was never whitelisted. The lesson generalises past this one name:
**a tool absent from the matcher is a rule that is silently off**, however
carefully the guard handles it. `hooks-matcher.test.mjs` now fails if the matcher
and the guard's switch ever disagree again.

And a third time, the worst of them: **the guard's exit 2 did not survive the
shell.** PowerShell does not adopt a native command's exit code as its own, so
`node guard.mjs` exiting 2 left the hook process exiting 1 — non-blocking — and
every `BLOCKED` reached the harness as an ALLOW. A delegate briefed to fix a
frozen test had its edit refused and wrote the file anyway. The generated command
is now `node "<guard>"; if ($LASTEXITCODE -ne 0) { exit 2 }` on win32 only, with
`exit 2` rather than `exit $LASTEXITCODE` so that a crash or a missing
interpreter blocks too. On POSIX the bare form is correct and the PowerShell form
would be actively dangerous (`$LASTEXITCODE` is empty, so `exit ` exits 0).

Two further Windows traps live in the wrapper rather than the guard, and both
stopped a run before it began rather than weakening one: `spawnSync` on a bare
npm-installed CLI name is ENOENT (no `.exe`, and Node does no PATHEXT
resolution), and a Windows path interpolated into a *double*-quoted YAML scalar
makes the backslash open an escape. Resolve the package `bin` and spawn
`process.execPath`; single-quote paths in generated YAML.

The pattern across all four: **on Windows this system fails silently and looks
correct.** Nothing here was found by reading the config. Each one needed a real
run plus a check that compared what the log said against what actually happened.

## Verify against the log, not the summary

Every run ends with the working-tree changes, a frozen-files section that must
be empty, and a report read from the delegate's own durable session log: each
tool call with its arguments, each guard decision, and the token totals.

This is the answer to the house failure mode, which is **silent acceptance** — a
bad model name falls back to flash, a bad effort value is ignored, an image
becomes placeholder text, and nothing raises an error. Confirm from the log what
actually ran rather than assuming your flags took effect. The wrapper refuses a
bad `-m` before spending anything, but `-e` is **not** verified against
V4.1-Flash: whether flash rejects, honours or silently swallows an effort value
is not documented, so read the log rather than trusting the flag.

Untracked files hide from `git diff`, so read the `git status --short` section
too; a migration that adds 146 files otherwise reports as `1 file changed`.

**Read the guard-health warning.** The report flags any hook that exited with
neither 0 nor 2. That is the backstop behind the canary.

## Cost discipline

DeepSeek bills per token with no subscription, so waste shows up on the invoice.
It is cheaper than the caution suggests: **seven delegations during one
afternoon's testing cost three cents in total**, about half a cent each — and
that measurement was on flash, which is now the only model, so it applies
directly. The point of the discipline below is not pennies, it is not being
surprised.

**One model: `deepseek-flash`.** There is no model choice left to make, and the
old `pro`-by-default trade is gone with the model. Measured 2026-09-10 from
DeepSeek's own release notes and pricing page:

- V4.1-Flash shipped as `deepseek-flash`, and DeepSeek's note reads "V4.1 Flash
  has comprehensively surpassed V4 Pro" — so the reasoning premium that
  justified `pro` no longer buys anything.
- **`deepseek-v4-pro` is retiring.** After **2026-09-14** its requests are
  routed to V4.1-Flash and billed at the flash price regardless, so `-m pro`
  would have become a slower way to reach the same model.
- `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp` are legacy aliases,
  "temporarily routed" to the same place. The wrapper writes none of them.

Flash is not a "small" model: 1M context, 384K max output, `$0.15` in / `$0.60`
out per 1M tokens off-peak (against pro's `$0.66` / `$1.98`). Cache hits cost
`$0.003`. Peak rates are double throughout.

The wrapper **refuses** `-m pro` with exit 2 instead of remapping it, because a
run that ignored your flag and reported success is the silent acceptance this
page warns about two sections down.

**Reasoning tokens bill at the output rate and usually dominate.** One measured
19-step run spent 16,526 reasoning tokens out of 19,836 output. On a short
answer the thinking *is* the bill.

**Let the cache work.** Context caching is automatic, matches an exact prefix
from token 0, and a hit costs roughly 1% of a miss. A measured run read 540,032
cached tokens against 49,389 fresh ones. Anything that changes the top of a
prompt throws all of it away, so put the stable material first (repo
conventions, the spec, the frozen test) and the varying material last.

**Scope the brief.** The delegate re-reads files on your budget. Naming the two
files that matter beats letting it search a large repo.

**Say plainly that `cd` is refused.** A brief that says "run it from the repo
root" invites `cd X && node --test`, which the guard blocks as a shell control
operator. A measured `pro` run burned 51,180 reasoning tokens bouncing off that
before writing anything. The delegate's cwd is already the workspace root.

Check the balance any time with `setup-deepseek.mjs --verify-only`: a `402`
mid-delegation is otherwise easy to misread as a broken brief.

## Images: DeepSeek cannot see them

The hosted API accepts **no image input on any endpoint**, and, worse, it does
not error. Image parts are silently replaced with placeholder text, so you get a
fluent answer about content the model never saw.

So when a task involves a screenshot, diagram, scan or PDF page: **read it
yourself, and hand DeepSeek the text.** You have vision; it does not.

Claims that DeepSeek does cheap vision refer to the **open-weights** DeepSeek-OCR
line, which must be self-hosted on a GPU. That is a different product from the
API, and its efficiency numbers do not transfer to it.

## There is no code-graph tool in DeepSeek Harness

Checked 2026-08-20: `docs/tool-catalog.md` catalogues 25 tool packages with zero
"graph" hits, no `packages/*/package.json` name contains graph/index/symbol/ast,
`.agents/notes/` has 2,056 files and zero mentions of knowledge-graph or
code-intelligence, and the 20 repos under the `dsh-plugin` GitHub topic are
memory/design/diagram tools. An LSP is not a graph: it answers four questions
about a symbol, not "what breaks if I change this".

So if a task needs a call graph, either brief the delegate with the answer, or
give it a `mcp-gitnexus` overlay **deliberately** — see the example, and read its
caveats first.

## Gotchas

- **The sandbox confines writes only.** Network access and reads are not
  confined, so the delegate can reach the network and read anything you can.
  Moving the key into `$DSH_HOME/.credentials.yaml` keeps it out of
  `process.env` — it does **not** hide it from a deliberate `cat`.
- **The inherited environment beats the credentials file.** If
  `DEEPSEEK_API_KEY` is exported, the managed store is never consulted. The
  wrapper clears it for the child for that reason.
- **`uv` cannot write `~/.cache/uv` under `workspace-write`**, so delegates
  redirect `UV_CACHE_DIR` into the workspace. A summary mentioning that is a
  correctly-degraded run announcing itself, not a fault.
- **The sandbox denies child processes, so `node --test` cannot run under it.**
  The runner spawns one child per test file and every file fails with
  `spawn EPERM`. Measured 2026-08-20: a delegate whitelisted for
  `node --test tests/x.test.mjs` could not satisfy its own brief, and worked
  around it by running the file in-process — which the guard then had to allow or
  refuse on a command that was never whitelisted. Whitelist the spawn-free form
  instead (`node tests/x.test.mjs` runs `node:test` in-process and still exits
  non-zero on failure). The same trap applies to any runner that forks per file.
- **A whitelisted command is matched as a bare command.** The guard rejects any
  shell control operator (`;`, `&&`, `|`, backticks, `$(`, redirection), because
  a prefix match alone would let `<allowed> && curl evil` through. Leading
  `VAR=value` assignments are allowed, since the sandbox forces them.
- **`glob.pattern` is a path and is checked; `grep.pattern` is content and is
  not.** Blocking a grep for the word "credentials" in a docs repo would be a
  false positive on the common case, so a pathless grep stays uncovered — the
  primary control for secrets is to delegate in a git worktree, where the
  gitignored directory does not exist at all.
- **Model names change, fast.** `deepseek-chat` and `deepseek-reasoner` were
  discontinued 2026-07-24. `deepseek-v4-pro` retires 2026-09-14, and
  `deepseek-v4-flash` / `deepseek-v4-flash-vision-exp` are already legacy
  aliases routed elsewhere. `deepseek-flash` is the current id. Any tutorial —
  or any earlier version of this plugin — using the others is stale.
- **Prices are rising.** The pricing page carries its own warning. Re-read it
  before quoting a number to anyone.
- **No free tier.** A `402` means an empty balance, not a bad request.
- **Do not run two delegations in one repo at once**: they edit the same working
  tree and will clobber each other. Use separate worktrees, or go sequentially.
- **Never put `ANTHROPIC_BASE_URL` in `~/.claude/settings.json`.** It would
  redirect every Claude Code session on the machine to DeepSeek, including the
  one supervising the delegation, and the failure is confusing rather than loud.
  The wrapper scopes those variables to the child process for exactly this reason.
- **Do not point Codex CLI at DeepSeek.** It needs a forwarding proxy, and
  DeepSeek's setup for it overwrites `~/.codex/config.toml`, breaking an
  existing `codex-invoke` setup.

## Reference files

Read them rather than recalling. Every claim in the first two is dated and
sourced, because this is a fast-moving API on top of a preview-grade harness.

- `references/dsh.md` — the harness: install, patch rows, permission presets,
  session-log format, hook-bridge steps, measured costs, and what was evaluated
  and rejected.
- `references/deepseek-api.md` — the API: models, endpoints, thinking mode,
  prices, and the image trap, each with a date and a source.
- `../_delegation/README.md` — why the guard is Node here, and the differential
  test that stops it drifting from the bash original.
- `${CLAUDE_PLUGIN_ROOT}/examples/` — `.deepseek/` templates to copy.

The repository's own `README.md` and `CLAUDE.md` are NOT shipped in the plugin
cache -- it holds only `commands/`, `examples/`, `overlays/`, `scripts/` and
`skills/`. Do not point a user at `${CLAUDE_PLUGIN_ROOT}/README.md`; the seam and
the floor are documented above.

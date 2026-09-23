<!-- Vendored into this plugin from lanhp-vn/ubuntu-setup
     skills/deepseek-invoke/references/dsh.md on 2026-08-20.
     Script names were rewritten .sh -> .mjs: the plugin's scripts are
     Node ports, and dsh runs hooks through PowerShell on Windows where
     a .sh cannot execute. Every measured claim below is unchanged. -->

# DeepSeek Harness (`dsh`): verified facts

Every claim here was observed on this host (Ubuntu 26.04, Node v24.18.0) on
**2026-08-15** against `dsh` **0.1.0-rc.6**, or read from the pinned checkout at
`ops-marcom-management/references/deepseek/deepseek-harness` (commit `47f9438`,
v0.1.0-rc.5; moved there from this repo's `references/deepseek-harness` on
2026-08-17). Items marked UNVERIFIED could not be confirmed; carry the label
forward rather than quietly promoting them.

`dsh` is a **developer preview** whose own README says "THERE WILL BE
COMPATIBILITY-BREAKING CHANGES". Re-check before relying on any of this.

## What it is

An open-source agent harness from DeepSeek, MIT, built on Cordis, where
**everything is a plugin**. It supersedes the old claim that "DeepSeek publishes
no coding CLI" — that was true until 2026-08 and is now wrong.

## Install

```sh
npm i -g @deepseek-ai/dsh@0.1.5-rc.2   # standalone; does NOT need a repo checkout. PIN IT -- see below
npm i -g pnpm                  # only needed for `dsh plugin ... add`
```

Requires Node `^22.19.0 || >=24`. On this host npm installs into
`~/.local/node-current/bin`, which is **not on PATH**; the machine's convention
is a symlink from `~/.local/bin` (that is how `node`, `npm`, `gitnexus` are
exposed), so:

```sh
ln -sfn ~/.local/node-current/bin/dsh  ~/.local/bin/dsh
ln -sfn ~/.local/node-current/bin/pnpm ~/.local/bin/pnpm
```

npm blocks install scripts for `node-pty`, `@google/genai` and `protobufjs`
with an `allow-scripts` warning. Headless runs work anyway. If one ever fails on
a native module, `npm approve-scripts node-pty` is the fix.

`$DSH_HOME` defaults to `~/.dsh` and holds `profiles/`, `sessions/`,
`.credentials.yaml`, `settings.yaml`.

## The headless surface is a task string and nothing else

```
Usage: dsh --profile headless [options] [task...]
Arguments:  task        the task text; multiple words are joined by spaces
Options:    -h, --help  show this help
```

That is the *entire* command line — verified from its own `--help`. There is no
`--model`, no `--permission-mode`, no `--allowed-tools`. **Every per-run choice
is a cordis patch row supplied with `--patch <file>`, or an environment
variable.** This single fact determines the whole shape of `deepseek-run.mjs`.

It prints the last non-empty assistant message on stdout and exits 0 when the
final turn is `completed`, else 1. A successful run writes nothing to stderr and
opens no port.

## The patch rows that matter

Confirmed present in the real composed tree (`dsh --profile headless --dump-config`,
333 lines). Use the dump as ground truth — it shows what is actually there after
all bundle layers, which the bundle sources alone do not.

```yaml
- id: agent-default-model          # deepseek-flash is the only model (2026-09-10)
  config: {provider: deepseek-official, model: deepseek-flash}

- id: sandbox-policy
  config:
    mode: workspace-write          # or read-only | danger-full-access
    workspaceRoot: "/abs/path"     # defaults to process.cwd()

- id: tool-web
  config: {fetch: false, searchTimeoutMs: 60000}

- insert:                          # add a plugin row
    - id: hooks-cc
      name: '@deepseek-ai/dsh-hooks-claude-code'
      config: {configPath: /abs/hooks.json, projectDir: /abs/workspace}
```

Permission presets are exactly three, each pairing a sandbox mode with an
approval policy: `read-only` (ask), `workspace-write` (ask),
`danger-full-access` (approval `never`). `DSH_PERMISSION_MODE` sets the process
fallback. `DSH_TOOLS_MODE` selects `native` | `code` | `both`.

**UNVERIFIED:** `llm-deepseek` carries no config in the composed tree, so a
`reasoningEffort` or `thinking` key would be a new key rather than an override.
Not measured — do not document values for it. Same for `compaction-basic`, which
also carries no config, so `compaction: {auto: false}` is not a known-valid key.

## Model-visible tools in the base composition

`write`, `edit`, `read`, `read_image` (`tool-fs`, parameter `file_path`);
`bash` (`tool-bash`); `glob`, `grep` (`tool-fs-search`). Knowing these exact
names matters: a hook matcher that misses one polices nothing for that tool.

## Credentials

`$DSH_HOME/.credentials.yaml` is a **flat mapping and nothing else**:

```yaml
DEEPSEEK_API_KEY: sk-...
```

A nested shape is rejected outright. Mode 0600 under a 0700 directory, enforced —
any group or other bit fails the load with an error naming the `chmod 600` repair.

**The inherited process environment ALWAYS wins over the file.** So the file only
takes effect if `DEEPSEEK_API_KEY` is genuinely unset, which is why
`deepseek-run.mjs` runs the delegate under `env -u DEEPSEEK_API_KEY`.

**It is discretion, not a boundary.** From the provider's own README: the 0600
file "stops other OS users — **not** the model", because tool processes run as
the same user and `workspace-write` confines mutations rather than reads. What it
buys is that the key stays out of `process.env`, so it is not handed to every
subprocess and does not appear in an `env` dump. A deliberate `cat` still reads it.

Note `web-search-deepseek` is configured `apiKeyEnv: DEEPSEEK_API_KEY`, so
unsetting the variable also disables web search. For a delegated implementer that
is a feature, not a loss.

## The sandbox confines writes only

> `SandboxMode` governs filesystem effects only. […] **Network and process
> visibility are outside this vocabulary.**
> — `docs/subsystems/sandbox.md:11`

So under `workspace-write` the delegate can still reach the network and read
anything the user can read. `tool-web` ships with `fetch: false` already (the
local fetch backend "does not block private-network targets"), which is a shipped
default rather than something a wrapper needs to change — but keep setting it
explicitly so a future default change is not silently inherited.

Measured consequence: `uv` cannot write `~/.cache/uv` under `workspace-write`, so
delegates redirect `UV_CACHE_DIR` into the workspace. A summary mentioning this is
a correctly-degraded run announcing itself, not a fault.

## The session log is the audit trail

Path: `$DSH_HOME/sessions/<slugified-cwd>/session-<uuid>/session.jsonl.zstd`

**Zstandard-compressed**, not plain JSONL; `zstd -dc` yields one JSON object per
line. **Every payload is nested under `.data`** — reading `.name` off the envelope
returns null, which is a silent wrong answer rather than an error.

| Event | Fields |
|---|---|
| `tool/call` | `.data.name`, `.data.arguments` (a JSON *string*), `.data.callId` |
| `tool/result` | paired by `.data.callId` |
| `assistant/message` | `.data.usage.{inputTokens,outputTokens,cacheReadTokens,reasoningTokens}` |
| `hook/invoked`, `hook/result` | `.data.{decision,exitCode,stderrSummary}` |
| `turn/end` | `.data.reason.kind` — `completed` on success |

`SESSION_FORMAT_VERSION` is **0 with no compatibility promise**
(`AGENTS.md:7`), so this parser will break on some future release.
`session-report.mjs` degrades to a notice rather than failing the run.

It decodes the log with Node's own `zstdDecompressSync`, one frame at a
time. dsh appends ONE ZSTD FRAME PER WRITE, and both `zstdDecompressSync`
and the stream decompressor stop after the first — measured 2026-08-20, 199
bytes against `zstd -dc`'s 1,045,056 on a live log. A reader that takes the
first frame reports "no tool calls recorded" for a run that made hundreds,
and the guard-health warning never fires. Frame-splitting output is
byte-identical to `zstd -dc`, and needs neither `zstd` nor `jq` — neither of
which exists on Windows.

## The hook bridge

`@deepseek-ai/dsh-hooks-claude-code` `0.0.1-rc.5` runs an ordinary Claude Code
`hooks.json` against the delegate's tool calls. Two install steps that are not
documented anywhere obvious:

1. It declares `@deepseek-ai/dsh-hook-protocol` as a **peerDependency**, which
   pnpm does not install. Without it the entire plugin tree fails to boot —
   `Cannot find package '@deepseek-ai/dsh-hook-protocol'`, exit 1 in about a
   second. Fix: `dsh plugin --profile headless add @deepseek-ai/dsh-hook-protocol`.
2. The peer range is `^0.0.1-rc.5` but npm's latest `dsh-hook-protocol` is
   **`0.0.1-rc.1`** — unsatisfiable. pnpm warns and installs rc.1, which works.

Both plugins warn "declares no `dsh.bundle` — installed as a plain dependency,
not a profile layer". Expected: the `--patch` overlay mounts the row.

Only 7 of Claude Code's 30 hook events are supported; the other 23 are dropped at
parse. `PreToolUse` can `deny` and `ask` but **cannot pre-approve** — the hook
narrows permissions and never widens them.

## Costs, measured

Seven delegations against a small repo during one afternoon's testing moved the
balance from **9.63 to 9.60 USD** — three cents total, roughly half a cent each
on `flash`.

One representative 19-step, 167 s run:

```
input 8108   cache_read 360192   output 19836   reasoning 16526   steps 19
```

Two things to read off that. **Prefix caching carries ~98% of the input** with no
configuration. And **reasoning was 16.5k of the 19.8k output** — the thinking is
the bill, which is why `max` effort on a trivial task is close to pure waste.

Every run also issues a `session/title-llm-request` — a separate billed request
purely to name the session. Small, but it is spend you did not ask for.

## Plugins installed into the headless profile (2026-08-19)

Seven packages, one pnpm tree. A package with **no `dsh.bundle` is inert** —
installed as a plain dependency, contributing nothing until a `--patch` overlay
mounts its row. That is what makes per-repo scoping cheap; see `overlays/`.

```
@deepseek-ai/dsh-mcp-client   0.0.1-rc.1   @deepseek-ai/dsh-terminal        0.0.1-rc.3
@deepseek-ai/dsh-lsp          0.0.1-rc.1   @deepseek-ai/dsh-terminal-bash   0.0.1-rc.3
@deepseek-ai/dsh-lsp-stdio    0.0.1-rc.5   @deepseek-ai/dsh-tool-terminal   0.0.1-rc.5
@deepseek-ai/dsh-tool-lsp     0.0.1-rc.1
```

**Published versions are inconsistent and none matches the checkout's
`0.1.0-rc.5`.** `pnpm peers check` reports unmet peers (`dsh-lsp-stdio@rc.5` wants
`dsh-lsp@^0.0.1-rc.5`; `dsh-tool-terminal@rc.5` wants `dsh-terminal@^0.0.1-rc.5`;
`@deepseek-ai/cordis` is missing outright). **The tree boots anyway** — verified
via `--dump-config`. Re-check after any upgrade.

Measured facts from live runs on 2026-08-19:

- **The MCP bridge works end to end.** A delegate called
  `mcp__gitnexus__list_repos` and received real graph data.
- **`node-pty` is already compiled for linux-x64** in the profile tree
  (`build/Release/pty.node` loads); the `allow-scripts` warning did not leave it
  unbuilt, so the PTY route needs no `npm approve-scripts`.
- **`terminal_send` carries its shell input in `text`**, not `command` — a deny
  rule matching the wrong field would police nothing.
- **A patch row that only sets `disabled: true` works**, and the composed dump
  annotates which overlay applied it. It renders *after* the `config:` block.
- **MCP tools are not in the hook matcher** unless named explicitly, so only a
  tool-name deny reaches them.

### GitNexus MCP: three env vars that do nothing

`GITNEXUS_MCP_READ_ONLY`, `GITNEXUS_MCP_ALLOWED_REPOS` and
`GITNEXUS_MCP_DEFAULT_MAX_TOKENS` are set in this machine's Claude Code MCP
config. **gitnexus 1.6.9 reads none of them** — zero occurrences in its entire
`dist`, verified by grep. They restrict nothing, for any client.

The mutation ban that *is* real comes from Claude Code's `permissions.deny`
(`mcp__gitnexus__rename`, `__cypher`, `__group_sync`) — a Claude Code mechanism a
dsh delegate never sees. Mounting `dsh-mcp-client` therefore hands a delegate
three unguarded graph-write tools unless the guard denies them by name, which is
why `--deny-tool` exists. Verified live: the block landed in the session log as
`block (exit 2)`.

## Windows: VERIFIED 2026-08-20, after three fixes

**Status: real delegations have now run on native Windows.** Node v22.17.1,
win32, `dsh` 0.1.0-rc.7, plugin 2.0.0, PowerShell as `ctx.shell`.

Nothing worked on the first attempt, and **not one of the three defects
announced itself as a Windows problem**:

- `spawnSync('dsh', ...)` is ENOENT here — npm ships `dsh`, `dsh.cmd` and
  `dsh.ps1` but no `dsh.exe`, and Node does no PATHEXT resolution without
  `shell: true`; naming the `.cmd` directly is EINVAL. The backend could not
  launch **at all**. Fixed by resolving the package `bin` and spawning
  `process.execPath`.
- `workspaceRoot` was interpolated into a *double*-quoted YAML scalar, where a
  backslash opens an escape, so dsh refused the patch in `composeProfile` with
  "expected hexadecimal character" before the delegate started.
- `pwsh` was absent from the PreToolUse matcher. dsh names its shell tool `pwsh`
  here, so `--allow-test` and `--deny-cmd` were enforcing **nothing**: 6 tool
  calls against 3 hook invocations, and the delegate ran a command that was never
  whitelisted.
- **The guard's exit 2 did not survive the shell.** PowerShell does not adopt a
  native command's exit code as its own, so `node guard.mjs` exiting 2 left the
  hook process exiting **1** — a non-blocking error — and every `BLOCKED` was
  delivered to the harness as an ALLOW. Found by running check 4 for the first
  time: a delegate told to fix a frozen test had its edit refused, printed
  `BLOCKED`, and wrote the file anyway. Fixed by generating
  `node "<guard>"; if ($LASTEXITCODE -ne 0) { exit 2 }` on win32 only — `exit 2`
  and not `exit $LASTEXITCODE`, so a crash (1) or a missing interpreter (`$null`)
  also blocks rather than sailing through.

The last two are the ones to remember, because **the canary reported the boundary
live for both.** Its probe was a frozen-path write spawned as `node <guard>`
directly — so it exercised the one half that worked, on an execution path
production never uses. Two changes follow from that:

- the canary now runs **the exact command string from the generated `hooks.json`,
  through the same shell dsh will use**. A probe that skips the wrapper certifies
  nothing about the wrapper.
- it now runs **two** probes: one call that must be blocked *and* one that must be
  allowed. The Windows hook form is fail-closed, so a broken guard blocks
  everything and would otherwise pass a block-only probe while being entirely
  non-functional.

That second change alters a documented behaviour: a guard with no `policy.json`
used to be reported as a live boundary because it fails closed. It now aborts the
run. Failing closed is safe but useless — such a guard refuses every tool call, so
the run is paid for and the delegate can do nothing.

The five checks below were therefore *not sufficient as written*. Check 5 was
added for the matcher gap; check 4, which nobody had run, is what exposed the
exit-code collapse.

What is mechanically true already:

- the hook command names the interpreter — `node "<path>\delegation-guard.mjs"`,
  not a bare script path, which PowerShell cannot execute;
- nothing shells out to `curl`, `jq` or `zstd`, none of which ship on Windows —
  `fetch` and `zstdDecompressSync` are Node builtins;
- `homedir()` is used rather than `$HOME`, which is normally unset on Windows;
- the guard imports only `node:` builtins, so no `node_modules` is required —
  and the plugin cache does not get one (measured: `import('yaml')` from the
  cache fails with `ERR_MODULE_NOT_FOUND`).

The checks, with results:

1. `/plugin marketplace add lanhp-vn/deepseek-claudecode-plugin`,
   `/plugin install dsh@dsh`, `/dsh:setup`. — **PASS.** Setup reports the
   hook bridge present, the key accepted, both models, and a balance.
2. Run a `--dry-run` and open the generated `hooks.json`. The command must read
   `node "C:\...\delegation-guard.mjs"`. — **PASS**, with the interpreter named
   and the path backslash-escaped inside the JSON string.
3. Run a real delegation. **It must not abort at the canary.** An abort here
   means the guard is unreachable — which is exactly what the canary exists to
   tell you, and exactly what used to pass silently. — **PASS**, after fix 1 and
   fix 2 above. Two delegations completed; contract green both times, under two
   cents total on `flash`.
4. Give a delegate a brief that instructs it to edit the frozen test. Then
   `git diff -- <frozen>` must be empty, and the session log must record
   `block (exit 2)`. — **PASS, and it is the check that earned its keep.** Run
   for the first time on 2026-08-20 it *failed*: the log read `pass (exit 1)` and
   the frozen file was rewritten (the delegate then restored it of its own
   accord, which is luck, not a boundary). After the exit-code fix the same brief
   gives two `block (exit 2)` decisions, an empty `git diff -- <frozen>`, a
   byte-identical blob, and no guard-health warning. Do not skip this check
   because the others pass — none of them touches the block path.
5. **Compare the guard-decision count against the matched tool-call count** in
   the run report. They must agree. This is the check that catches a matcher gap,
   which checks 1-4 all pass straight over: 6 calls against 3 decisions is a
   silently unenforced allowlist. — **PASS** after fix 3 (4 calls, 4 decisions).

**All five are now automated.** `scripts/dsh-doctor.mjs` (`/dsh:test`) runs the
static half, the canary through the real shell, and one live delegation briefed
to attempt both a frozen write and an unwhitelisted command — then reads the
session log for the block decisions, the guard-health exits and the
decision-vs-call count. Run it after any change to the guard, the generator or
the wrapper, and on any machine where a delegation has not run before.

### A fourth Windows fail-open, found by that doctor on its first live run

**Measured 2026-08-21, `dsh` 0.1.0-rc.7, Node v22.17.1, win32.** A frozen file
was ALLOWED. dsh's `write` tool sends an absolute `file_path`, so the guard
compared `C:\...\workspace\contract.txt` against a frozen entry of
`contract.txt` — and every path matcher in the guard speaks `/`, so
`endsWith('/contract.txt')` was false and it exited 0. The same gap disabled
every `denyPath` rule (`.env*`, `credentials/**`) for absolute paths.

Check 4 passed on 2026-08-20 only because that delegate happened to write a
relative path. Nothing else was wrong: the canary was live, the matcher covered
`pwsh`, the hook command carried the exit suffix, and the counts agreed. The
frozen file survived that run purely because dsh's own `write` tool refuses to
overwrite a file the delegate has not read.

Fixed by normalising separators once where paths enter the guard, not in each
matcher; `guard-paths.test.mjs` fails without it. Same class as the other three:
**on Windows this system fails silently and looks correct**, and only a live run
compared against the log exposes it.

The `--backend claude-code` fallback is **not** covered by any of this and has
still never been run on Windows. One blocker it does *not* have: Claude Code
ships a real `claude.exe`, so the bare-`spawnSync` ENOENT above does not apply
to it.

## Evaluated and rejected

- **JSON-RPC SDK** (`@deepseek-ai/dsh-sdk-client` `0.0.1-rc.1`) and the **ACP
  server**. They look like the "real" integration, but the protocol has **no
  mid-turn cancellation** (UNVERIFIED: reported by an agy sweep of `packages/sdk`,
  not confirmed against the protocol source), so abandoning an off-brief run still
  means killing the process — which the plain CLI already allows. Higher
  integration cost, nothing gained over CLI + hooks + session log.
- **`dsh-session-log-export`.** Looks like a headless log exporter; it is
  **web-only** — a browser download button and `/export` slash command mounted by
  the Web bundle. `dsh-session-stats` is likewise a UI projection.
- **A `tui` profile.** Only three bundles ship: `dsh-base`, `dsh-headless`,
  `dsh-web-app`. `--profile tui` in `dsh --help` is illustrative, not shipped.
- **`dsh-subagent-claude-code` / `dsh-subagent-codex`.** They let the cheap
  implementer spend Opus/GPT tokens unsupervised on a brief you did not write.
  `codex-invoke` and `agy-invoke` already do that, driven by you.
- **A native Cordis plugin** instead of the hooks bridge. Architecturally what
  `dsh` recommends, and typed. But it is dsh-only (no Codex transplant), needs a
  build step, and pins us to a preview-grade plugin API. Revisit when `dsh`
  stabilises.

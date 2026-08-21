# Onboarding: the `dsh` plugin

A step-by-step walkthrough for setting this up on a new machine.

**What you get.** Claude plans, specifies and verifies. DeepSeek V4 writes the
implementation, inside a filesystem sandbox, under a guard that refuses to start
unless it can prove it is working. You review the diff and the delegate's own
session log — not its summary.

**What it costs.** DeepSeek bills per token with no subscription and no free
tier. Seven delegations during one afternoon of testing cost three cents in
total. The discipline in the skill is about not being *surprised*, not pennies.

**The fastest path** is at the bottom: one prompt you paste into Claude Code,
which installs everything, verifies it, then reads your project and tells you
which dsh capabilities it actually needs. Read the rest first if you want to
know what it is doing.

---

## Prerequisites

| | |
|---|---|
| **Node** | `^22.19.0 \|\| >=24`. Check with `node --version`. |
| **Claude Code** | `>= 2.1.233` for `claude plugin validate`. |
| **git** | for the marketplace clone. |
| **A DeepSeek API key** | from https://platform.deepseek.com/api_keys — pay-as-you-go, no free tier. |

The plugin itself has **no runtime dependencies**. Nothing to `npm install`,
nothing that can be missing. (This is deliberate: Claude Code does *not* install
a plugin's node dependencies into its cache — verified 2026-08-20, `import('yaml')`
from the cache fails with `ERR_MODULE_NOT_FOUND`. Anything the plugin needed
beyond `node:` builtins would be broken on your machine.)

---

## Install, step by step

### 1. The plugin

```
/plugin marketplace add lanhp-vn/deepseek-claudecode-plugin
/plugin install dsh@dsh
```

If the marketplace add fails and you want the clone kept for inspection, set
`CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE=1` first.

### 2. The harness

```sh
npm i -g @deepseek-ai/dsh      # the default backend
npm i -g pnpm                  # needed by `dsh plugin ... add` below
```

If npm installs somewhere off your PATH (common with a `node-current` layout),
symlink `dsh` and `pnpm` into a directory that is on it.

npm will block install scripts for `node-pty`, `@google/genai` and `protobufjs`
with an `allow-scripts` warning. Headless runs work anyway; only if a native
module actually fails do you need `npm approve-scripts node-pty`.

### 3. The hook bridge — **do not skip this**

```sh
dsh plugin --profile headless add @deepseek-ai/dsh-hooks-claude-code @deepseek-ai/dsh-hook-protocol
```

A bare `dsh` install ships **neither**, and without them **every delegation dies
at boot**. The wrapper mounts the guard by inserting a row naming
`@deepseek-ai/dsh-hooks-claude-code`; dsh cannot resolve it and exits 1 in about
a second with `Cannot find package`.

`dsh-hook-protocol` is that package's peerDependency, which pnpm does not
install on its own. Its declared peer range (`^0.0.1-rc.5`) is unsatisfiable —
npm's latest is `0.0.1-rc.1`. pnpm warns and installs rc.1, which works.

### 4. Your key

```
/dsh:setup
```

or directly. `$CLAUDE_PLUGIN_ROOT` is only set inside a plugin command, **not**
in an ordinary shell, so use the cache path there:

```sh
DS=~/.claude/plugins/cache/dsh/dsh/*/scripts
node $DS/setup-deepseek.mjs --key sk-... --dsh
```

This writes `~/.deepseek/api-key` (0600), installs the key into
`$DSH_HOME/.credentials.yaml` so it stays out of `process.env`, and scaffolds
`~/.deepseek/machine.yml` — the one per-machine file, which you **never commit**.

The key is never printed; every message shows a masked fingerprint.

### 5. Verify before you spend anything

```sh
node ~/.claude/plugins/cache/dsh/dsh/*/scripts/setup-deepseek.mjs --verify-only
```

Doctor mode. It reports Node's version and platform, which shell dsh will run
hooks through, **whether the hook bridge is present**, whether the key is
accepted, the available models, and your balance. Reach for it first whenever a
delegation fails confusingly — a `402` is an empty balance, not a bad brief.

### 6. Prove the guard actually blocks

```
/dsh:test
```

`--verify-only` above proves your credentials and plumbing. It cannot prove the
part that has failed silently three times: that the guard **refuses** what it is
supposed to refuse. `/dsh:test` composes a real run, probes the deployed guard
through the shell dsh will use, then spends about a cent on one delegation
briefed to attempt two calls that must be refused, and reads the session log to
confirm they were. Run it after install, after every update, and on any machine
where a delegation has not run before.

The other two skills: `/dsh:update` checks the four upstreams that move
independently and re-tests afterwards; `/dsh:tools-check` does Phase 2 below for
you, against the repo you are actually in.

### 7. Updating, later

Two slash commands, in this order:

```
/plugin marketplace update dsh     # 1. refresh the local clone
/plugin update dsh@dsh             # 2. then install from it
```

`/plugin update` installs from the marketplace **clone on your disk**, not from
GitHub, so running it alone against a stale clone reinstalls stale code under an
unchanged version number. Measured 2026-08-21: the clone sat four commits behind
a cache that was current, both reporting the same version — updating the plugin
without updating the marketplace first would have replaced a working guard with
one missing the Windows exit-code fix, silently.

Confirm by CONTENT, not by version string: grep the new cache directory for a
string only the new code has. Then run `/dsh:test`, which is the only check that
proves the guard still blocks.

`/dsh:update` does the checking half of all this for you, across all four
upstreams that move independently, and changes nothing until you approve it.

---

## What a repository declares for itself

Per-project capability lives in two committed files at the repo root, and both
are optional:

```
<repo>/.deepseek/overlay.yml   what a delegate may USE  (a dsh patch layer)
<repo>/.deepseek/policy.yml    what it may NOT do       (deny sets)
~/.deepseek/machine.yml        this machine's paths     (never committed)
```

A repository with no `.deepseek/` gets the base composition plus a permanent
deny floor — a working configuration, not a degraded one. Copy a starting point
from the plugin's `examples/`.

Two rules make a committed file safe to read:

- **A repo policy can only ADD denies.** It is unioned with the floor and can
  never subtract from it; an `allowTool` key in a committed file is not read at
  all. Otherwise "clone this repo and delegate in it" would be a way to hand a
  delegate capability nobody granted. The only escape hatch is the operator's
  `--allow-tool` flag.
- **Capability never arrives silently with a clone.** The first time a given
  `overlay.yml` is seen at a given path, the run refuses and prints what the
  file would mount. You approve it once, after reading it.

**Quote your globs.** `- *.enc` is an *alias* in YAML and a real parser rejects
it outright. Write `- "*.enc"`.

---

## The prompt

Paste this into Claude Code, from inside the project you want to use DeepSeek
on. It installs, verifies, then reads your project and recommends what — if
anything — that project should mount.

````
You are setting up the `dsh` Claude Code plugin on this machine and
then advising me on how to configure it for THIS project. Work in two phases and
stop for my confirmation between them.

## Phase 1 — install and verify

Walk me through installation step by step. For each step: say what it does and
why, run what you can run yourself, and tell me exactly what to type when a step
needs the Claude Code slash-command interface (which you cannot invoke).

1. Check prerequisites and report versions: `node --version` (need
   `^22.19.0 || >=24`), `claude --version` (need >= 2.1.233), `git --version`.
   Stop and tell me if any is missing or too old.
2. Tell me to run `/plugin marketplace add lanhp-vn/deepseek-claudecode-plugin`
   and then `/plugin install dsh@dsh`. Wait for me to confirm.
3. Check whether `dsh` is on PATH. If not, tell me to run
   `npm i -g @deepseek-ai/dsh` and `npm i -g pnpm`, and warn that npm may install
   to a directory that is not on PATH.
4. THE STEP MOST LIKELY TO BE SKIPPED. Check whether the hook bridge is present:
   read `$DSH_HOME/profiles/headless/package.json` (default `~/.dsh`) and confirm
   BOTH `@deepseek-ai/dsh-hooks-claude-code` and `@deepseek-ai/dsh-hook-protocol`
   are dependencies. If either is missing, tell me to run:
       dsh plugin --profile headless add @deepseek-ai/dsh-hooks-claude-code @deepseek-ai/dsh-hook-protocol
   Explain that a bare `dsh` install ships neither, that the wrapper mounts the
   guard by naming the first package, and that without them dsh exits 1 at boot
   with `Cannot find package` — every delegation fails, not just some.
5. Tell me to run `/dsh:setup` to install my API key. Never echo a key back
   to me; if I paste one into the conversation, tell me it is now in my
   transcript and that rotating it is cheap.
6. Run the doctor yourself and show me its output. Note $CLAUDE_PLUGIN_ROOT is
   NOT set in an ordinary shell, so resolve the cache path:
       node ~/.claude/plugins/cache/dsh/dsh/*/scripts/setup-deepseek.mjs --verify-only
   Confirm: hook bridge present, key accepted, a non-zero balance, and which
   shell dsh will run hooks through on this platform.
7. Prove the plugin's own code is sound before trusting it. BOTH script
   directories -- the second holds hooks-matcher.test.mjs, which is what catches
   a guard rule going silently off:
       C=$(echo ~/.claude/plugins/cache/dsh/dsh/*)
       node --test "$C"/scripts/*.test.mjs "$C"/skills/_delegation/scripts/*.test.mjs
   Report the pass/fail counts. Anything other than 0 failures is a stop. A large
   skipped count is expected: the differential cases need both guard
   implementations named, and have no bash reference on Windows.

Then summarise what is installed and STOP. Ask me to confirm before Phase 2.

## Phase 2 — recommend a `.deepseek/` seam for THIS project

Now analyse the repository we are in and recommend what it should declare. Be
concrete and be sceptical: every capability is paid in the prompt prefix of
EVERY request, so the correct answer for most repositories is "the base
composition and nothing else".

First, understand the project. Do not guess — measure:

- What languages, by file count, excluding vendored/`node_modules`/`.venv` paths?
- Is there a package/project manifest (`package.json`, `pyproject.toml`,
  `go.mod`, `Cargo.toml`, `tsconfig.json`)? A language server needs something to
  resolve against; loose scripts with no manifest give it nothing.
- What is the test command, and does it run project-authored code (pytest with
  `conftest.py`, `npm test` scripts, `make`)? That matters for `--allow-test`.
- Which paths hold secrets, credentials, personal data, or executed-once
  infrastructure state?
- Does the repo's own AGENTS.md / CLAUDE.md / README forbid anything specific
  (deploys, migrations, pushes, hardware commands)? Those become deny rules.
- Is there anything genuinely irreversible a command could do — a deploy, a
  training run, a device flash, a DB migration?

Then recommend, with reasons, from THIS closed list. **Do not invent package
names**; every name below is verified present in DeepSeek Harness at the commit
this plugin pins. If the plugin repo is checked out with submodules you can
confirm anything against `references/deepseek-harness/docs/tool-catalog.md`.

Already mounted by the base composition — do not recommend adding these.
The exact model-visible names are `write`, `edit`, `read`, `read_image`
(tool-fs), `bash` (tool-bash), and `glob`, `grep` (tool-fs-search).

Mandatory, and already covered in Phase 1:
  @deepseek-ai/dsh-hooks-claude-code, @deepseek-ai/dsh-hook-protocol

Opt-in, worth considering:
  @deepseek-ai/dsh-lsp + @deepseek-ai/dsh-lsp-stdio + @deepseek-ai/dsh-tool-lsp
      A language server. All three rows are needed. Only worth it for a typed
      language WITH a manifest AND a server binary installed on this machine
      (pyright-langserver, typescript-language-server, …). Worthless for prose,
      and this is per-request cost. Recommend `--no-overlay` for markdown tasks
      IN A REPO THAT MOUNTS ONE -- the flag also drops 00-base.yml, so in a repo
      with no overlay it buys nothing and re-enables a billed session-title
      request (measured 2026-08-21).
  @deepseek-ai/dsh-mcp-client
      Bridges an external MCP server; tools appear as `mcp__<serverName>__<name>`.
      Config keys are FLAT: serverName, transport, command, args,
      failOnStartupError, toolCallTimeoutMs. Recommend only with the
      confidentiality caveat below.
  @deepseek-ai/dsh-terminal + @deepseek-ai/dsh-terminal-bash + @deepseek-ai/dsh-tool-terminal
      A persistent PTY. RECOMMEND AGAINST unless the work genuinely needs a live
      shell: a PTY accepts anything typed after it opens, so it WEAKENS
      `--allow-test` to nearly nothing. If it is mounted, the deny sets must
      carry every rule that matters, because the command whitelist no longer
      bounds execution.

Never recommend:
  @deepseek-ai/dsh-tool-cordis — it executes dynamic packages in the live
      runtime. Its tools are denied by the plugin's permanent floor.

Two caveats you must state if you recommend an MCP code-graph server:
  1. There is NO per-repo scoping — every index on the machine is visible, so a
     delegate briefed on one private repo can query another's graph. Across a set
     of private company repos that is usually disqualifying.
  2. If it is gitnexus: `GITNEXUS_MCP_READ_ONLY` and `GITNEXUS_MCP_ALLOWED_REPOS`
     are read by nothing in 1.6.9. They restrict nothing. The graph mutators are
     stopped by the plugin's floor, at the guard, by tool name.

Finally, produce two draft files and show them to me — do NOT write them without
my approval:

- `.deepseek/overlay.yml` — only the rows you justified above, with a header
  comment saying which files they serve and when to pass `--no-overlay`. Use
  `${machine.<key>}` for anything machine-specific (interpreter paths, binary
  paths) and tell me what to put in `~/.deepseek/machine.yml`.
- `.deepseek/policy.yml` — only what is SPECIFIC to this repo. The floor already
  covers `.env*`, `*.key`, `*.pem`, `credentials/**`, `**/.ssh/**`, `.git/config`,
  `git push`, `git push --force`, `git reset --hard`, `git clean -fdx`. Do not
  repeat those. Quote every glob.

Then tell me the exact command to approve the overlay once I have read it, and a
concrete first delegation to try on this repo — a small, well-specified task with
a real test as its contract. Remind me that the frozen test must be COMMITTED
before the delegate is launched, or `git status` cannot tell its edits from mine.

If anything about this project is ambiguous, ask me rather than assuming.
````

---

## After a delegation, always

1. `git status --short` **alongside** `git diff` — untracked files hide from the
   diff, so a migration that adds 146 files otherwise reports as "1 file changed".
2. `git diff -- <frozen>` must be empty. The guard blocks the direct route, but
   a delegate allowed to run a command that executes project code can have *that*
   code edit a frozen file. One did exactly that, then deleted the helper. **The
   diff is what holds.**
3. Read the run report's guard-health line. It flags any hook that exited with
   neither 0 nor 2 — a non-2 exit is a NON-BLOCKING error, so those calls were
   ALLOWED however correct the config looked.

## Windows

Everything here is Node specifically so it works on native Windows, where dsh
runs hooks through PowerShell and the old shell-script guard silently failed
open. **Verified by real delegations on 2026-08-20** (Node 22.17.1, `dsh`
0.1.0-rc.7) — but only after three Windows defects were fixed, one of which left
`--allow-test` enforcing nothing while the canary still reported the boundary
live. See `plugins/dsh/skills/run/references/dsh.md`, section
"Windows: VERIFIED 2026-08-20", for the five checks, what each one proved, and
what is still unproven.

If a delegation behaves oddly here, the cheapest first check is the run report:
the guard-decision count must match the matched tool-call count. If shell calls
are not being hooked, those two numbers disagree.

## Maintainers

```sh
git submodule update --init references/deepseek-harness   # the pinned harness, reference only
node --test plugins/dsh/scripts/*.test.mjs plugins/dsh/skills/_delegation/scripts/*.test.mjs
UBUNTU_SETUP=~/Documents/system-settings node scripts/vendor-delegation.mjs --check
```

The submodule is **not** needed to install or use the plugin — it sits outside
`plugins/`, so Claude Code never copies it into anyone's plugin cache.

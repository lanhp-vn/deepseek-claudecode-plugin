# dsh — a Nouslogic Claude Code plugin

Claude plans, specifies and verifies. **DeepSeek V4 writes the code** — inside a
sandbox, behind a guard that refuses to start unless it can prove it blocks.

```
      YOU
       │  "implement this spec"
       ▼
 ┌───────────────┐   brief + frozen test   ┌──────────────────────┐
 │    CLAUDE     │ ──────────────────────► │     DeepSeek V4      │
 │ plans, specs, │                         │   writes the code    │
 │    verifies   │ ◄────────────────────── │  in a write-sandbox  │
 └───────┬───────┘   diff + session log    └──────────┬───────────┘
         │                                            │ every tool call
         ▼                                 ┌──────────▼───────────┐
  you read the diff,                       │  guard (PreToolUse)  │
  not the delegate's                       │    allow / BLOCK     │
  summary                                  └──────────────────────┘
```

Two things here are called `dsh`, and they are not the same:

| | |
|---|---|
| `/dsh:…` **with the colon** | this plugin's six commands |
| bare `dsh` | the DeepSeek Harness CLI it drives, installed separately below |

---

## Install

```
/plugin marketplace add nouslogic/deepseek-claudecode-plugin
/plugin install dsh@nouslogic
```

```sh
npm i -g @deepseek-ai/dsh@0.1.5-rc.2            # the harness -- pinned; CLI and bridge MUST match
npm i -g pnpm                                  # needed by `dsh plugin ... add`
dsh plugin --profile headless add @deepseek-ai/dsh-hooks-claude-code@0.1.5-rc.2 \
  @deepseek-ai/dsh-hook-protocol@0.1.5-rc.2 @deepseek-ai/dsh-session-projection@0.1.5-rc.2
```

```
/dsh:setup     # your API key
/dsh:test      # prove the guard blocks — do not skip this
```

> [!IMPORTANT]
> **That third `npm`/`dsh` line is not optional.** A bare `dsh` install ships
> none of those packages. The plugin mounts its guard by naming the first one, so
> without them dsh exits at boot with `Cannot find package` and *every*
> delegation fails. `dsh-hook-protocol` is a peerDependency that pnpm will not
> pull in on its own.
>
> **Keep the versions pinned and identical to the CLI.** The bridge is
> version-locked to the harness, and these packages' npm `latest` tags do *not*
> agree with the CLI's — so an unpinned install silently pairs a current CLI with
> a bridge a whole release line behind. That combination fails every tool call
> *and* leaves the guard mounted but never firing: a delegation that looks
> guarded and is not. `/dsh:test` checks the pairing (`profile lockstep`).

| | |
|---|---|
| **Node** | `^22.19.0 \|\| >=24` |
| **Claude Code** | `>= 2.1.233` |
| **A DeepSeek key** | [platform.deepseek.com](https://platform.deepseek.com/api_keys) — pay-as-you-go, **no free tier** |
| **Runtime deps** | none, deliberately. Nothing to `npm install`, nothing that can go missing |

- The marketplace and repo are private — your GitHub account needs `nouslogic` access.
- Add failed and you want the clone kept? Set `CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE=1` first.
- **Upgrading from `deepseek-invoke` (1.0.1 or earlier)?** The plugin was renamed
  in 2.0.0 and a plugin's name is its cache directory, so run
  `/plugin uninstall deepseek-invoke@nouslogic` first. Your key is untouched — it
  lives in `~/.deepseek/`, not in the plugin cache, so there is no need to re-run setup.

Full walkthrough, and a prompt that installs and configures all of this for you:
**[`ONBOARDING.md`](ONBOARDING.md)**.

---

## The six commands

| Command | What it does |
|---|---|
| `/dsh:setup` | Installs and verifies your API key; scaffolds `~/.deepseek/machine.yml` |
| `/dsh:run` | The delegation itself — Claude briefs, DeepSeek writes, Claude verifies |
| `/dsh:test` | Proves the guard really blocks. One real delegation, **about a cent** |
| `/dsh:tools-check` | Reads *this* repo and fits its `.deepseek/` seam to what it actually is |
| `/dsh:update` | Checks the four upstreams that move independently, then re-tests |
| `/dsh:research` | Sends a delegate to read the public web and report back with sources |

**When to run `/dsh:test`:** after install, after every update, after touching the
guard, and on any machine where a delegation has not run before.

It spends money because it has to. Every fail-open this plugin exists to fix
looked perfect in the configuration and passed every check that spent nothing —
including one found by `/dsh:test` itself, on its first ever run.

### Updating

Two slash commands, and **the order is load-bearing**:

```
/plugin marketplace update nouslogic     # 1. refresh the local clone
/plugin update dsh@nouslogic             # 2. then install from it
```

`/plugin update` installs from the marketplace **clone on your disk**, not from
GitHub. Run it alone against a stale clone and it reinstalls stale code under an
unchanged version number — so both sides report success and nothing moved.

- `/dsh:update` checks all four upstreams first and tells you what is actually due.
- Then `/dsh:test`. An update is not finished until the guard is proven again.
- Your key is untouched — it lives in `~/.deepseek/`, not in the plugin cache.

---

## What a run actually does

```
/dsh:run  ──►  compose  ──►  approve?  ──►  canary  ──►  delegate writes  ──►  report
                  │             │             │                                  │
        overlay + policy   first sight    proves the guard             tool calls, guard
        + machine.yml      of a repo's    really blocks —              decisions, tokens,
                           overlay        else ABORT,                  and the log path
                           stops the run  nothing spent
```

Two gates stand between a clone and a spend:

| Gate | Stops | Why |
|---|---|---|
| **Approval** | the first run against a repo's `overlay.yml` | capability must never arrive silently with a `git clone`. The run prints what the file would mount and spends nothing |
| **Canary** | any run whose deployed guard does not discriminate | the harness treats a guard that cannot execute as *non-blocking* — it allows the call. A broken guard looks identical to a working one in the config |

Approval is hashed over the file's raw bytes and keyed by absolute path: two
clones are two decisions, and editing the overlay re-arms the gate.

> [!WARNING]
> There is **no flag to skip the canary**, and none should be added.

---

## What a repo declares for itself: the `.deepseek/` seam

```
<repo>/.deepseek/overlay.yml    what a delegate may USE     committed
<repo>/.deepseek/policy.yml     what it may NOT do          committed
~/.deepseek/machine.yml         this machine's paths        NEVER committed
```

Both repo files are optional. **A repo with no `.deepseek/` gets a working
configuration**, not a degraded one. Starting points live in
[`plugins/dsh/examples/`](plugins/dsh/examples).

A Python repo that wants a language server:

```yaml
# myrepo/.deepseek/overlay.yml            (committed)
- insert:
    - id: lsp-stdio
      name: '@deepseek-ai/dsh-lsp-stdio'
      config:
        servers:
          python:
            command: pyright-langserver
            args: ['--stdio']
            initializationOptions:
              pythonPath: ${machine.python}
```

```yaml
# ~/.deepseek/machine.yml                 (yours, never committed)
python: /home/you/venvs/myrepo/bin/python

# myrepo/.deepseek/policy.yml             (committed)
denyCmd:
  - alembic upgrade
```

- A `${machine.*}` key referenced but not set is a **hard failure naming the
  key**, before anything is spent — never a blank that mounts a dead server.
- **Quote your globs.** `- *.enc` is a YAML *alias* and a real parser rejects it.
  Write `- "*.enc"`.
- Not sure what your repo needs? `/dsh:tools-check` measures it and proposes the
  files, writing nothing until you agree.

---

## What a delegate can never do

A repo's `policy.yml` is **unioned** with a permanent floor and can only ever
**ADD** denies. An `allowTool` key in a committed file is not read at all —
otherwise "clone this repo and delegate in it" would hand a delegate capability
nobody granted. The only escape hatch is the operator's own `--allow-tool` flag,
which lives in a hand and in the session log.

The floor denies, always:

| | |
|---|---|
| **tools** | the gitnexus graph mutators; `cordis_*`, which executes dynamic packages in the live runtime |
| **paths** | `.env*`, `*.key`, `*.pem`, `credentials/**`, `**/.ssh/**`, `.git/config` |
| **commands** | `git push`, `git push --force`, `git reset --hard`, `git clean -fdx` |

Network tools are off by the same logic, one layer up: the wrapper writes
`fetch: false` into `tool-web` on every run, so a delegate has no page-fetching
tool to call. `/dsh:research` is the single opt-in, and it is a **flag**
(`--web-fetch`) rather than a repo setting, for the same reason `allowTool` is
not read from a committed file.

---

## What the guard does *not* do

It blocks the direct route. **It is not a boundary.**

- A delegate allowed to run a command that executes project code — `pytest`
  reading `conftest.py`, `npm test`, `make` — can have *that code* edit a frozen
  file. One did exactly this, then deleted the helper.
- The sandbox confines **writes only**. Reads and network are not confined *at
  the process level* — a whitelisted command that can reach the internet can
  still reach it. What IS controlled is the delegate's network **tools**:
  `web_fetch` is not registered at all unless a run passes `--web-fetch`
  (`/dsh:research` does; nothing else should), and when it is, the guard refuses
  loopback, link-local, private, CGNAT and cloud-metadata targets. That rule
  reads the URL as written and does not resolve DNS, so it stops the literal and
  the careless — it is not an SSRF boundary.
- `git diff -- <frozen>` is what actually holds. The guard buys cost and an
  audit trail.

**After every delegation:** `git status --short` *alongside* `git diff` —
untracked files hide from the diff — then read the run report's guard-health
line.

---

## Contributing

Everything about working *on* this code — architecture, the invariants, the
Windows hazards, the test discipline — is in **[`CLAUDE.md`](CLAUDE.md)**.

```bash
node --test plugins/dsh/scripts/*.test.mjs plugins/dsh/skills/_delegation/scripts/*.test.mjs
```

Private to Nouslogic.

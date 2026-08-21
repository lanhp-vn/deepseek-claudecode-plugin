# deepseek-invoke — a Nouslogic Claude Code plugin

Claude plans, specifies and verifies. **DeepSeek V4 writes the implementation**,
inside a sandbox, under a guard that refuses to start unless it can prove it is
working.

```
/plugin marketplace add git@github.com:nouslogic/deepseek-claudecode-plugin.git
/plugin install deepseek-invoke@nouslogic
/deepseek-setup
```

If the marketplace add fails and you want the clone kept for inspection, set
`CLAUDE_CODE_PLUGIN_KEEP_MARKETPLACE_ON_FAILURE=1` first.

Requires **Node `^22.19.0 || >=24`** and, for the default backend,
[`dsh`](https://github.com/deepseek-ai/deepseek-harness):

```sh
npm i -g @deepseek-ai/dsh                      # the harness
npm i -g pnpm                                  # needed by `dsh plugin ... add`
dsh plugin --profile headless add @deepseek-ai/dsh-hooks-claude-code @deepseek-ai/dsh-hook-protocol
```

**That third line is not optional.** A bare `dsh` install ships neither package,
and the wrapper mounts the guard by inserting a row naming the first one — dsh
exits 1 at boot with `Cannot find package` when it is missing, so *every*
delegation fails rather than some. `dsh-hook-protocol` is its peerDependency,
which pnpm does not install on its own. `--verify-only` checks for both and
names what is missing.

The plugin itself has **no runtime dependencies** — nothing to install, nothing
that can be missing. That is deliberate: Claude Code does *not* install a
plugin's node dependencies into its cache (verified 2026-08-20 — `import('yaml')`
from the cache fails with `ERR_MODULE_NOT_FOUND`).

Full walkthrough, and a prompt that installs and configures this for you:
[`ONBOARDING.md`](ONBOARDING.md).

## Why this exists in Node

dsh runs command hooks through `ctx.shell`, which is **PowerShell on Windows**.
The original guard was a `.sh` file. PowerShell cannot execute it, so the hook
exited with a non-2 code — and the hook protocol says *"Exit 2 blocks with
stderr; other failures are non-blocking."*

So on Windows, `hooks.json` looked correct and **every protection was off, on
every run**. A `.ps1` twin was rejected: two implementations of a security
boundary drift, and a guard that disagrees with itself across platforms is worse
than an absent one, because it gets trusted. Everything is Node, which adds no
prerequisite — `dsh` *is* Node.

`skills/_delegation/scripts/differential.test.mjs` feeds this guard and the bash
original the same payloads and fails if they ever disagree.

## Per-project capability: the `.deepseek/` seam

A repository declares what its delegations may use, and the deny set that bounds
it, in two committed files:

```
<repo>/.deepseek/overlay.yml   what the delegate may USE  (a dsh patch layer)
<repo>/.deepseek/policy.yml    what it may NOT do         (deny sets)
~/.deepseek/machine.yml        this machine's paths       (never committed)
```

Both are optional. A repository with no `.deepseek/` gets the base composition
plus the permanent floor — a working configuration, not a degraded one. Copy a
starting point from `examples/`.

Worked example — a Python repo that wants a language server:

```yaml
# myrepo/.deepseek/overlay.yml   (committed)
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
# ~/.deepseek/machine.yml        (per-machine, NEVER committed)
python: /home/you/venvs/myrepo/bin/python
```

```yaml
# myrepo/.deepseek/policy.yml    (committed)
denyCmd:
  - alembic upgrade
```

A `${machine.*}` key referenced but not set is a **hard failure naming the key**,
before anything is spent — never an empty string, which would mount a server
with a blank command and fail silently.

**Quote your globs.** `- *.enc` is an *alias* in YAML and a real parser rejects
it. Write `- "*.enc"`.

## Two rules that make a committed file safe to read

**A repo policy can only ADD denies.** `policy.yml` is unioned with a permanent
floor and can never subtract from it; an `allowTool` key in a repo file is not
read at all. Otherwise "clone this repo and delegate in it" would be a way to
hand a delegate capability nobody granted. The only escape hatch is the
operator's `--allow-tool`, which lives in a hand and in the session log.

The floor denies:

| | |
|---|---|
| tools | the gitnexus graph mutators; `cordis_*`, which executes dynamic packages in the live runtime |
| paths | `.env*`, `*.key`, `*.pem`, `credentials/**`, `**/.ssh/**`, `.git/config` |
| commands | `git push`, `git push --force`, `git reset --hard`, `git clean -fdx` |

**Capability never arrives silently with a clone.** The first time a given
`overlay.yml` is seen at a given path, the run refuses and prints what the file
would mount:

```
REFUSED: /repo/.deepseek/overlay.yml is not approved on this machine.

  It would mount:
    + lsp-stdio (@deepseek-ai/dsh-lsp-stdio)
      uses ${machine.python} from ~/.deepseek/machine.yml

  Review the file, then approve it:
    deepseek-run --approve-overlay -C /repo

  Nothing has been spent.
```

The hash is over the raw bytes before substitution, so it is machine-independent,
and it is keyed by absolute path — two clones are two decisions. Editing the
overlay re-arms the gate.

## The canary

Only exit 2 blocks a tool call. A guard that cannot execute exits 127, which the
harness treats as a non-blocking error and **allows the call**. Measured
2026-08-15: a guard placed outside the sandboxed workspace exited 127 and every
decision came back `pass`, while the config looked perfect.

So before anything is spent, the wrapper asks the deployed guard to block
something it must block. If it does not, the run aborts:

```
deepseek-run: ABORTED -- the guard did not block the canary (exit 1). The
harness treats any non-2 exit as non-blocking, so this run would be UNGUARDED.
Nothing has been spent.
```

**There is no flag to skip it, and none should be added.** It is the check that
would have caught both that incident and the Windows fail-open.

## What the guard does not do

It blocks the direct route. It is not a boundary. A delegate allowed to run a
command that executes project code — `pytest` reading `conftest.py`, `npm test`,
`make` — can have *that* code edit a frozen file. One did exactly that, then
deleted the helper. `git diff -- tests/` caught it in one command.

**The diff is what holds.** The guard raises the cost and leaves an audit trail.

## Maintenance

The harness source is vendored as a reference submodule and is **not needed to
install or use the plugin** — it sits outside `plugins/`, so Claude Code never
copies it into anyone's plugin cache, and an ordinary clone leaves it empty.
Maintainers who want it:

```bash
git submodule update --init references/deepseek-harness
```

Run the tests before changing anything under `skills/_delegation/`:

```bash
cd plugins/deepseek-invoke/scripts && node --test *.test.mjs
cd ../skills/_delegation/scripts && \
  BASH_GUARD=~/Documents/system-settings/skills/_delegation/scripts/delegation-guard.sh \
  NODE_GUARD=$PWD/delegation-guard.mjs node --test differential.test.mjs
```

Private to Nouslogic.

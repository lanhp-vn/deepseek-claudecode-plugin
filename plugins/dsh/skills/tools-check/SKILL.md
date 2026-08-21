---
name: tools-check
description: >-
  Look at the repository dsh will run in, work out which harness tools and deny
  rules it actually needs, and set up its `.deepseek/` seam. Use this whenever
  the user says "/dsh:tools-check", "what tools should dsh use here", "optimise
  dsh for this project", "set up .deepseek for this repo", "should I mount an
  LSP", "which dsh plugins do I need", or asks why a delegation in this repo is
  slow, expensive, or keeps failing to find things. ALWAYS use it the first time
  dsh is pointed at an unfamiliar repository, and again after the repo's
  language, test runner or deploy tooling changes. It proposes exact file
  contents and commands and writes nothing until the user agrees. Do NOT use it
  to install Claude Code plugins or MCP servers for Claude itself -- this is
  about what the DeepSeek delegate gets.
---

# `/dsh:tools-check` — fit the seam to the repo

A repository declares what its delegations may use, and the deny set that bounds
them, in two committed files:

```
<repo>/.deepseek/overlay.yml   what the delegate may USE  (a dsh patch layer)
<repo>/.deepseek/policy.yml    what it may NOT do         (deny sets)
~/.deepseek/machine.yml        this machine's paths       (never committed)
```

Both are optional. **A repo with no `.deepseek/` gets the base composition plus
the permanent floor, which is a working configuration and not a degraded one.**
So the honest answer here is often "mount nothing" — say that when it is true,
rather than finding something to add.

Propose first, write only after the user agrees.

## Pass 1 — read the repository

Enough to answer four questions. Do not read the whole tree.

| Question | Where to look |
|---|---|
| What is it written in, mostly? | file counts by extension; `pyproject.toml`, `package.json`, `go.mod`, `Cargo.toml`, `*.csproj` |
| What defines "done"? | the test runner and how it is invoked — `package.json` scripts, `pytest.ini`, `Makefile`, CI workflow |
| What must never be run by an agent? | deploy, publish, migrate and infra commands in those same files |
| Is the work code or prose? | a docs- or config-dominant repo needs no language server at all |

Note anything that changes the cost picture: a very large tree (the delegate
re-reads files on the user's budget), generated directories, vendored code.

## Pass 2 — read what the harness actually offers, today

Do not recite a catalogue from memory; the harness is a preview and the package
set moves. Check at runtime:

- `$DSH_HOME/profiles/headless/package.json` — what is already installed
  (`$DSH_HOME` defaults to `~/.dsh`)
- `dsh --profile headless --dump-config` — what is actually composed, which is
  the ground truth the bundle sources do not give you
- `${CLAUDE_PLUGIN_ROOT}/examples/` — three ready templates to copy from
- `../run/references/dsh.md` — measured facts about the packages, including what
  was evaluated and **rejected**, so a rejected thing is not re-proposed

A package with no `dsh.bundle` is **inert** until a patch row mounts it. That is
what makes per-repo scoping cheap: installing costs nothing at run time,
mounting does.

## Pass 3 — the cost calculus, which is the whole point

**An MCP server's or language server's tool schemas are paid in the prompt
prefix of every request.** That is the reason to scope per repo rather than
mount everything once. Three consequences worth telling the user plainly:

- Mount an LSP only where the delegate's tasks are genuinely code work in that
  language. For a markdown or config job in a repo that already has an overlay,
  `--no-overlay` skips it per run and still carries the full deny set.
- **Do not recommend `--no-overlay` for a repo with no overlay.** It also drops
  `overlays/00-base.yml`, whose only content disables `session-title-llm` — a
  billed request on every run to name a session nothing reads. Measured with two
  dry runs on 2026-08-21: identical tools either way, one extra billed request
  with the flag. The advice is "skip the language server", not "prose means
  `--no-overlay`".
- Prefer briefing the delegate with two file paths over mounting a tool so it
  can find them itself. Naming the two files that matter beats a search.
- Put the stable material first in a brief. Prefix caching matches from token 0
  and a hit costs about 1% of a miss; anything that changes the top throws all
  of it away.

## What to suggest, given what you found

| Signal | Suggestion | Watch out for |
|---|---|---|
| Python-dominant, real code work | copy `examples/lsp-python/` | needs `pyright-langserver`; the interpreter is `${machine.python}`, never a literal path |
| TypeScript/JavaScript | copy `examples/lsp-typescript/` | needs `typescript-language-server` on PATH, otherwise use `${machine.*}` |
| Another compiled or typed language | the same three rows with that language's stdio server and its `extensionToLanguage` map | verify the binary exists before proposing it |
| Docs, config, data files | **nothing** — write no overlay at all | do not mount an LSP "just in case", and do not then recommend `--no-overlay`: with no overlay to skip it only costs a billed request |
| A task genuinely needs a call graph | `examples/mcp-gitnexus/`, deliberately, after reading its three caveats | there is **no per-repo scoping** — it exposes every index on the machine. Across private repos, brief the answer instead |
| Long-lived interactive processes | the terminal/PTY packages | `terminal_send` carries shell input in `text`, and a PTY widens what `--allow-test` has to police |

Check that any binary you propose is actually installed, and that the harness
package actually **resolves**.

**Reading `package.json` alone under-reports what is available.** It lists only
what someone explicitly added to the profile — but Node resolves up the
directory tree, so packages shipped inside the global `dsh` install resolve from
the profile too. Measured 2026-08-21: `package.json` named only the two
hook-bridge packages, yet `@deepseek-ai/dsh-mcp-client` and
`@deepseek-ai/dsh-terminal` both resolved, while `@deepseek-ai/dsh-lsp` genuinely
did not. A run that checked the manifest alone concluded, wrongly, that mounting
an MCP client "would fail at boot". Resolve the name from
`$DSH_HOME/profiles/headless` (`import.meta.resolve`, or `dsh --profile headless
--dump-config`) before reporting a package as absent.

A missing value behind
`${machine.*}` is a hard failure naming the key — the good outcome — but a bare
command name that is absent mounts a server that silently does nothing. When the
server is not installed and the binary is not there, "mount nothing" is the
correct answer and worth stating as a finding rather than a shrug.

**Never invent a package name.** Every `@deepseek-ai/dsh-*` name you write must
come from the installed profile, the shipped `examples/`, or the verified list in
ONBOARDING.md Phase 2. A plausible-looking name that does not exist fails at
boot, and a delegate cannot tell you why. One name is never correct:
`@deepseek-ai/dsh-tool-cordis` executes dynamic packages in the live runtime and
its tools are denied by the permanent floor.

## Also propose, because they matter more than the overlay

**A deny set for this repo.** `policy.yml` is unioned with the permanent floor
and can only ADD. The floor already covers `.env*`, `*.key`, `*.pem`,
`credentials/**`, `**/.ssh/**`, `.git/config`, `git push`, `git reset --hard`,
`git clean -fdx` and the graph mutators — **do not repeat those**. A deny that
looks local but is actually global invites someone to "tidy it up" from the file
and believe they changed something. List only what is specific here: publish,
deploy, migration and infra commands found in pass 1, plus local state files.

**A test command for `--allow-test`.** It must be spawn-free: the sandbox denies
child processes, so `node --test` fails with `spawn EPERM` on every file, while
`node tests/x.test.mjs` runs in-process and still exits non-zero on failure. The
same trap applies to any runner that forks per file. And say plainly that a
whitelisted command which executes project code — `pytest` reading
`conftest.py`, `npm test`, `make` — grants arbitrary code execution by
construction; that is a trade the user should make knowingly.

**Frozen candidates.** The tests that define "done" for the work at hand.

### Two ways a deny rule bites the hand that wrote it

Both were hit independently by two runs on 2026-08-21, writing the obvious thing.

**A deny entry must not begin with `-`.** `- "-m integration"` is the natural way
to deny pytest's marker, and it used to abort the whole run at guard generation.
The wrapper now passes values as `--deny-cmd=<value>` so this composes, but the
glob form `"*-m integration*"` is still clearer about intent, and anchoring on
the command instead — `"pytest -m integration"` — is clearer still.

**A `denyPath` literal is substring-scanned against shell commands.** So denying
`.venv/**` in a repo whose allowed test command is `.venv/Scripts/python -m
pytest` blocks the one command the delegate is permitted to run. Before adding a
path deny, read it against the `--allow-test` command: if the literal appears
there, the two rules are in conflict and the path deny wins.

The nastier form: the scan uses the **longest glob-free segment**, so a short
segment collides widely. `denyPath: ["site/**"]` reduces to the literal `site`
and then blocks any command whose text contains it. Measured 2026-08-21:
`grep -n site_name mkdocs.yml` went from exit 0 to exit 2 on that one line, and
in a checkout named `docs-site-iter2` every command spelling out the workspace
path went with it. Commands that happen not to contain the segment (`python
scripts/check_links.py`) still run, which is what makes this intermittent and
baffling rather than obviously broken. Test a proposed deny against the real
guard before committing it: a path deny that reads as tidy housekeeping can take
unrelated commands down with it.

## Pass 4 — propose, then write

Show the exact bytes of each file and the exact commands, then ask. On yes:

1. Write `<repo>/.deepseek/overlay.yml` and `policy.yml`. **Quote every glob** —
   `- *.enc` is a YAML *alias* and a real parser rejects it; write `- "*.enc"`.
2. Add any `${machine.*}` keys to `~/.deepseek/machine.yml` with the real local
   paths. That file is per-machine by definition and **must never be committed**;
   check it is not tracked.
3. Install any harness packages the overlay mounts:
   `dsh plugin --profile headless add <pkg>` (needs `pnpm`).
4. Compose without spending, and read the result:
   `node <plugin-root>/scripts/deepseek-run.mjs -C <repo> --dry-run "probe"`
5. Approve the overlay — **as a separate, deliberate step, by the user**:
   `node <plugin-root>/scripts/deepseek-run.mjs --approve-overlay -C <repo>`

Step 5 is a consent gate, not a formality. The first time an `overlay.yml` is
seen at a given path the run refuses and prints what the file would mount, so
capability never arrives silently with a clone. Show the user that summary and
let them approve; do not approve on their behalf because it is convenient.
Editing the overlay re-arms the gate, which is correct.

6. If harness packages were installed or upgraded, run `/dsh:test`. If only the
   two YAML files changed, the dry run in step 4 is enough — that change cannot
   affect the guard.

## Rules that hold no matter what the repo wants

- **A repo policy can only ADD denies.** An `allowTool` key in a committed file
  is not read at all. The only escape hatch is the operator's `--allow-tool`,
  which lives in a hand and in the session log, never in a file. Do not propose
  a committed file as a way to grant capability.
- **`machine.yml` is never committed**, and an overlay never contains a literal
  machine path.
- **A referenced-but-unset `${machine.*}` key is a hard failure naming the key**,
  before anything is spent. That is the designed behaviour; do not "fix" it by
  guessing a path.

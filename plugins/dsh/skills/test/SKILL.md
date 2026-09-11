---
name: test
description: >-
  Prove a dsh install actually works, end to end, before trusting it with a
  delegation. Use this whenever the user says "/dsh:test", "test dsh", "is dsh
  working", "verify dsh", "check my dsh setup", "did that break dsh", or
  "dsh is behaving oddly". ALWAYS use it immediately after /dsh:setup, after
  /dsh:update, after installing or upgrading the dsh harness or its plugins,
  after editing anything under scripts/ or skills/_delegation/, and on a machine
  or platform where a delegation has never run before. Also use it first when a
  delegation fails confusingly, when a run looks guarded but a frozen file
  changed, or when the user asks whether the guard is really on. It runs one
  real delegation costing about a cent, because the block path cannot be proven
  any other way. Do NOT use it to run a project's own test suite -- that is
  ordinary work, not this.
---

# `/dsh:test` — prove the boundary is live

One command. It ends in either "all checks passed" or a named failure.

```bash
node <plugin-root>/scripts/dsh-doctor.mjs
```

`${CLAUDE_PLUGIN_ROOT}` is not set in an ordinary shell. Resolve the plugin root
once with a glob — `~/.claude/plugins/cache/nouslogic/dsh/*/scripts/` — or, in a
checkout of this repo, `plugins/dsh/scripts/`. Then use the absolute path; that
works identically in bash and PowerShell.

| Flag | When |
|---|---|
| *(none)* | the normal case: static checks, then one live delegation (~1 cent) |
| `--no-spend` | no balance, no network to the API, or a quick shape check. **The block path stays unproven** |
| `--keep` | leave the throwaway fixture on disk to inspect |

The fixture is a temp workspace, never the user's repo: the live tier
deliberately provokes refused tool calls, and a self-test must not leave debris
in real work.

## Why it spends money

Every defect this plugin exists to fix **looked perfect in the config and passed
every check that spent nothing**. On 2026-08-20 the guard's exit 2 did not
survive PowerShell, so every BLOCK reached the harness as an ALLOW — the
canary, `hooks.json` and the composed profile all still looked right. On
2026-08-21, on this doctor's very first live run, a frozen file was allowed
because dsh sends an absolute Windows path and the matcher only spoke `/`.

Neither was findable by reading configuration. Both were obvious the moment a
real delegate attempted a refused call and someone read the log. So the live
tier is the default, and the static tier is what runs first to avoid paying for
a run against an install that is already broken.

The canary now probes that second failure directly — it asks the guard to refuse
a frozen file spelled with backslashes, the way dsh really spells one — so this
particular gap is caught before spending. That is the pattern to keep: when a
live run finds something the canary missed, the canary grows a probe for it.
What it still cannot cover is anything only a real delegate does.

The live brief is four steps: two that must succeed, two that must be refused.
Five turns on `flash`, about a cent.

## Reading a failure

Checks run in order and the live tier is skipped if anything above it failed —
there is no point paying to confirm a known-broken install.

| Check | What a FAIL means | Fix |
|---|---|---|
| `node` | below `^22.19.0 \|\| >=24`. A **warning**, not a failure: delegations have run on v22.17.1 | upgrade, and suspect this first if something below is strange |
| `dsh CLI` | not installed, or unresolvable on this PATH | `npm i -g @deepseek-ai/dsh@0.1.5-rc.2` (pin it; the bridge is version-locked to it) |
| `hook bridge` | the guard cannot mount; **every** delegation dies at boot | the `dsh plugin --profile headless add` line the check prints |
| `profile lockstep` | the hook bridge is on a different release line than the CLI. Measured 2026-09-10: that pairing fails **every** tool call and leaves the guard mounted but never firing — a run that looks guarded and is not | re-add the bridge packages pinned to the CLI's exact version; the check prints the command |
| `API key` | 401 is a bad key, 402 is an empty balance — there is no free tier | `/dsh:setup`, or top up |
| `dry run` | composition failed before spending. Read the stderr tail it prints | often a path-quoting or overlay error |
| `hook command` | the exit-code form is wrong for this platform | `hookCommandFor` in `gen-hooks.mjs` |
| `matcher` | dsh's shell tool for this platform is missing from the matcher, so `--allow-test` and `--deny-cmd` enforce **nothing** | the `parts` array in `gen-hooks.mjs`; `hooks-matcher.test.mjs` must fail too |
| `guard placement` | the guard is not inside the workspace root; it will exit 127, which the harness **allows** | `gen-hooks.mjs --out` |
| `policy.json` | the permanent floor did not compose | `policy.mjs` |
| `canary` | the deployed guard does not discriminate: it blocks nothing, blocks everything, or blocks a frozen path spelled `/` while allowing the same file spelled `\` | read the detail line; usually a missing `policy.json`, a crashing guard, or a path matcher that lost its separator normalisation |
| `frozen file` | **the guard is not holding.** Stop; do not delegate against this install | the path matcher, then re-run |
| `guard ran` / `guard health` | a hook exited neither 0 nor 2, so those calls were ALLOWED | the hook command form, or a guard crash |
| `matcher coverage` | matched calls outnumber decisions: calls are slipping past unhooked and a rule is silently off | the matcher, again |
| `block path` | a call that had to be refused was not | the exit-code collapse, or a path-spelling gap like the 2026-08-21 one |

`session log` deserves a special mention: read it **before** the decisions
table. If a run wrote no log the report falls back to the newest log on disk,
which may belong to a different project, and prints that session's tool calls
and guard decisions under your run — a stale log is indistinguishable from a
fresh one by content alone. A session id or cwd slug that does not match the run
gives it away. Immediately after a harness bump this usually means the log
filename gained a new version infix (`session.jsonl.zstd` →
`session.v3.jsonl.zstd` on 2026-09-10), which is `session-report.mjs` to fix.

Two warnings are normal and mean "not proven", not "broken": `--no-spend`
skipping the live tier, and the delegate declining to attempt a refusable step
(re-run; the model does not always take the bait).

## It tests the copy you point it at

`dsh-doctor.mjs` composes a run using the scripts and guard sitting beside it, so
it proves *that* tree. Invoked as `/dsh:test` the path resolves inside the
installed plugin cache, which is the copy Claude Code actually loads and the one
you want tested. Run from a checkout, it proves the checkout — which can be a
different answer, and on 2026-08-21 it was: the checkout held a guard fix that
the installed cache did not, and a green run from the source tree said nothing
about the install. When the question is "is my *install* sound", run the doctor
from the cache path, or compare the two trees by content.

## What it does not reach

- **The `--backend claude-code` fallback.** Never covered here, and never run on
  Windows at all.
- **The sandbox's write confinement.** Reads and network are not confined and
  this does not pretend to test them.
- **Anything past the direct route.** A whitelisted command that runs project
  code can still edit a frozen file through that code. The doctor proves the
  guard blocks direct writes; `git diff -- <frozen>` after a real delegation is
  still what holds.

## Discipline

**Never add a flag that skips the canary or the block-path assertion.** They are
the two checks that have caught real fail-opens; every other check passed while
those failures were live.

If a check fails and the fix is not obvious, prefer weakening nothing. A doctor
that reports health it did not measure is worse than no doctor, because it is
believed. When a check is genuinely inapplicable, make it print `WARN` with the
reason rather than `PASS`.

When changing the doctor, run its own tests and mutation-check them —
break the product, confirm the test fails and names the right thing, restore:

```bash
node --test plugins/dsh/scripts/dsh-doctor.test.mjs
```

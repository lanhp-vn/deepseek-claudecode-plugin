---
name: update
description: >-
  Check every moving part of the dsh stack for an upstream update, then apply
  what the user approves and re-verify. Use this whenever the user says
  "/dsh:update", "update dsh", "upgrade dsh", "is there a new version of dsh",
  "update the deepseek plugin", "am I on the latest dsh", or asks why a
  delegation that used to work now fails after an upgrade. Four upstreams move
  independently -- this plugin, the dsh harness CLI, the harness plugin packages
  in the headless profile, and (for maintainers) this repo's checkout -- and a
  mismatch between them is silent. Also use before relying on dsh after a long
  gap. Do NOT use it to update unrelated npm packages or a project's own
  dependencies.
---

# `/dsh:update` — four upstreams, checked together

`dsh` is a developer preview whose own README says "THERE WILL BE
COMPATIBILITY-BREAKING CHANGES". Nothing here is a routine bump: **an update is
not finished until `/dsh:test` passes on the other side of it.**

Work in three passes — **check everything, report, then apply what the user
approves** — rather than updating one thing at a time. A half-updated stack is
the state where failures get misdiagnosed.

## Pass 1 — check, change nothing

Read; do not install. Four independent things:

**1. This plugin.** Compare what is installed against what the marketplace has.

| What | Where |
|---|---|
| installed version | the directory name under `~/.claude/plugins/cache/dsh/dsh/` |
| marketplace version | `version` in `~/.claude/plugins/marketplaces/dsh/.claude-plugin/marketplace.json` |

The marketplace directory is an ordinary git clone, so `git -C <that path> fetch`
then `git -C <that path> log --oneline -5 HEAD..@{u}` shows what is waiting.
Read those files with the file tools rather than shelling out — the paths differ
between platforms but the tools do not.

**The version string proves nothing, and the order of the two commands is
load-bearing.** `/plugin update` installs from the marketplace *clone*, not from
GitHub, so a stale clone reinstalls stale code under an unchanged version
number. Found on 2026-08-21: the cache held the current tree while the clone sat
four commits back on a revision whose guard was missing the Windows exit-code
fix — running `/plugin update dsh@dsh` alone would have overwritten
working code with a fail-open guard, and both sides would still have said
`2.0.0`. So: update the marketplace first, then the plugin, and confirm by
content rather than by version — compare the installed tree against the source
(line endings normalised; `core.autocrlf` makes a raw byte diff report that
everything changed), or grep the cache for a string only the new code has.

**2. The harness CLI.**

```bash
npm ls -g --depth=0 @deepseek-ai/dsh
npm view @deepseek-ai/dsh version
```

**3. The harness plugin packages.** These live in the headless profile, not in
npm's global tree: read `dependencies` from
`$DSH_HOME/profiles/headless/package.json` (`$DSH_HOME` defaults to `~/.dsh`)
and compare each entry with `npm view <pkg> version`.

The two that must be there at all are `@deepseek-ai/dsh-hooks-claude-code` and
`@deepseek-ai/dsh-hook-protocol`. Without them the guard cannot mount and
*every* delegation dies at boot.

**4. A maintainer checkout**, only when the working directory is a clone of this
repo (`.claude-plugin/marketplace.json` at its root): `git fetch`, then report
`git status --short` and `git log --oneline HEAD..@{u}`.

## Pass 2 — report, then let the user choose

Show a short table: component, installed, available, and what changing it
touches. Then stop and ask. Two of these carry real risk and the user should
decide with that in front of them:

- **The harness CLI** is preview-grade. A new rc can move the headless command
  line, the patch-row ids the wrapper writes, or the session-log format.
- **The profile packages** are inconsistently published — the pinned versions
  never matched the checkout, `pnpm peers check` reports unmet peers, and the
  tree boots anyway. "Unmet peer" is not a reason to upgrade.

If nothing has moved, say so plainly and stop. Do not run `/dsh:test` to fill
the silence; it costs money.

## Pass 3 — apply, in this order

Cheapest and most reversible first, so a failure has the smallest blast radius.

**The plugin.** Claude cannot run Claude Code's slash commands. Hand the user
the two lines to type, in this order:

```
/plugin marketplace update dsh
/plugin update dsh@dsh
```

(In this session they can prefix a shell command with `!` to run it inline, but
`/plugin` is not a shell command — they must type it as a slash command.)

Credentials are untouched by a plugin update: they live in `~/.deepseek/` and
`$DSH_HOME`, not in the plugin cache. Re-running `/dsh:setup` is not needed.

**The harness CLI.**

```bash
npm i -g @deepseek-ai/dsh
```

On a machine where npm's global bin is not on PATH, the existing symlink
convention applies — check that `dsh --version` still answers afterwards, since
a fresh install can replace a shim.

**The profile packages.**

```bash
dsh plugin --profile headless add @deepseek-ai/dsh-hooks-claude-code @deepseek-ai/dsh-hook-protocol
```

Needs `pnpm` (`npm i -g pnpm`). Name only the packages that are actually
mounted; each one is inert until an overlay row mounts it, but each is still a
thing that can break.

**A maintainer checkout.** `git pull`, then — before anything else — the suite,
because these tests are the only thing standing between a merge and a silently
disabled guard:

```bash
node --test plugins/dsh/scripts/*.test.mjs plugins/dsh/skills/_delegation/scripts/*.test.mjs
UBUNTU_SETUP=~/Documents/system-settings node scripts/vendor-delegation.mjs --check
```

A large skip count is normal: the differential cases skip unless `BASH_GUARD`
and `NODE_GUARD` are set, and skip unconditionally on Windows.

## After an update, always

```bash
node <plugin-root>/scripts/dsh-doctor.mjs
```

Or invoke `/dsh:test`, which is the same thing with the failure table attached.
It spends about a cent and is the only check that proves the guard still blocks.

**Re-verify these three by hand after a harness upgrade**, because they are
assumptions the wrapper makes and none of them fails loudly:

| Assumption | How to check |
|---|---|
| the headless surface is still a task string and nothing else | `dsh --profile headless --help` |
| the patch rows the wrapper writes still exist (`agent-default-model`, `sandbox-policy`, `tool-web`, the `hooks-cc` insert) | `dsh --profile headless --dump-config` |
| the session log still decodes | the doctor's `session log` check; `SESSION_FORMAT_VERSION` is 0 with no compatibility promise |

If the doctor's `session log` check starts failing right after a harness bump,
the format moved — that is `session-report.mjs`, not a broken run.

## When an update breaks something

Do not patch around it in the wrapper on the spot. Establish which upstream
moved first: `--no-spend` isolates the composition from the delegation, and
`--dry-run` shows exactly what would be mounted without spending. The fallback
that exists for precisely this case is `--backend claude-code` (POSIX only), and
it is why that backend is still in the tree — do not delete it because the
default works today.

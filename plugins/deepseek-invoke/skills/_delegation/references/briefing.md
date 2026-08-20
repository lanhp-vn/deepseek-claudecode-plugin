<!-- VENDORED -- do not edit here
  upstream repo:   git@github.com:lanhp-vn/ubuntu-setup.git
  upstream path:   skills/_delegation/references/briefing.md
  upstream commit: ff9a4d4
  vendored:        2026-08-20

  This file is a VERBATIM copy. Edit it upstream and re-run
  scripts/vendor-delegation.mjs; edits made here are drift, and
  vendor-delegation.mjs --check will fail.

  The scripts under scripts/ are NOT verbatim -- they are Node ports of bash
  originals, checked behaviourally by differential.test.mjs rather than by
  hash. README.md here is plugin-authored for the same reason.
-->

# Briefing an implementer

Shared by `codex-invoke` and `deepseek-invoke`. (`agy-invoke` briefs an
investigator, not an implementer; its skeleton is different and stays in that
skill.)

An implementer is only as good as the brief. A good brief is a spec, not a wish.

## The skeleton

```
Task: <what to build, in one or two sentences>

Make this pass:  <exact command, e.g. `pytest tests/test_importer.py -q`>
Tests live in:   <path> -- these are FROZEN. Do not edit them. If a test looks
                 wrong, stop and explain instead of changing it.

You may edit:    <files/dirs in scope>
Constraints:     Follow existing patterns in <ref file>. No new dependencies
                 unless you note it. Keep the diff minimal.

Before you finish: run the command above, confirm it's green, then summarize
what you changed and why.
```

## Put the trap in the test's docstring, then point the brief at it

The brief is read once; the frozen test is read whenever someone is confused
about why it fails. So the *reason* a check exists belongs in the test file, and
the brief should open with "read `tests/test_x.py` FIRST — it documents the trap
below." Four consecutive mechanical handoffs landed with zero bounces on this
pattern, and the tests keep paying out long after the brief is gone.

The traps worth writing down are the ones where **the obvious check passes over
broken code**:

- A path rewrite that only matches the slash spelling silently skips
  `_REPO / "scripts" / "name"`, which is the form the code actually uses — so the
  rewrite reports success having changed nothing.
- Deleting `lib/transport.py` and rewriting imports that match `lib.transport`
  misses a sibling `from .transport import ...`, and a grep for `lib.transport`
  then prints CLEAN over a tree that cannot import. The only contract that
  catches it is one that **imports the modules** instead of grepping them.

## The frozen-tests rule, and exactly how far it is enforced

"Do not edit the tests" is the contract. Both wrappers can now *enforce* the
direct route with a generated `hooks.json` that runs
`_delegation/scripts/delegation-guard.sh` before every tool call:

- a `write` / `edit` / `apply_patch` touching a `--frozen` path is refused;
- a shell command that is not the `--allow-test` command is refused;
- every attempt is recorded in the delegate's durable log.

**This is a mechanism, not a boundary, and the difference is not academic.**
Measured 2026-08-15: a delegate blocked from editing a frozen test wrote a
`conftest.py`, let the whitelisted `pytest` command execute it, had *that* code
rewrite the frozen file, and then deleted the helper. It disclosed this in its
summary; it might not have. `git diff -- <frozen>` caught it in one command.

Whitelisting any command that runs project code — `pytest` reading
`conftest.py`, `npm test` running scripts, `make` — grants arbitrary code
execution by construction. So:

> The guard raises the cost of cheating and leaves an audit trail.
> **The diff is what actually holds.** Never skip it because the guard was on.

Two failure modes worth knowing before you trust a guarded run:

- **It fails OPEN.** Only exit 2 blocks. A guard that cannot execute exits 127,
  which the harness treats as a non-blocking error and allows the call. A run can
  look guarded in its config and be completely unguarded. `deepseek-run.sh`
  generates the guard inside the workspace for this reason, and the run report
  warns when any hook exits with neither 0 nor 2.
- **It only knows the tool names you gave it.** Codex writes files through
  `apply_patch`, not `write`/`edit`; a matcher missing `apply_patch` blocked
  nothing on Codex while working perfectly on dsh. Enumerate a delegate's real
  tool names with a `.*` logging hook before trusting any matcher.

## Bouncing

Each wrapper call is a **fresh, stateless process**. A bounce brief must restate
the task, what was already tried, and the exact failure — the delegate has no
memory of its last attempt. (`codex exec resume --last` is the exception, and it
continues the previous session with its context intact.)

Bound the ping-pong at ~2–3 focused retries. If the tests still are not green,
the problem is usually the *brief* or the *plan*, not the implementer:

- Is the test actually correct and achievable? Maybe *your* contract is wrong.
- Is the task too big? Split it.
- Is critical context missing? Add the file paths, patterns, or an example.

Then escalate to the user with what you tried and what you suspect, rather than
burning more runs.

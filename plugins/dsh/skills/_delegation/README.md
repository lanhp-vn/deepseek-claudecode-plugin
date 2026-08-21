# `_delegation` — shared material for the delegation skills

Not a skill. There is no `SKILL.md` here, so nothing in this directory can be
triggered; it exists so that `agy-invoke`, `codex-invoke` and `dsh:run`
have **one home** for the discipline all three share.

Before this directory existed, each skill restated the roles table, the briefing
rules and the verification gate in its own words. Three copies of a rule drift,
and the drift is invisible until two skills contradict each other in front of a
reader who cannot tell which is current.

| Path | What lives here |
|---|---|
| `references/routing.md` | Which delegate gets this task, and why picking wrongly is expensive |
| `references/briefing.md` | The brief skeleton, the frozen-tests rule, bounce discipline |
| `references/verification.md` | The gate: diff, untracked files, run the tests yourself, audit the session log |
| `scripts/delegation-guard.mjs` | `PreToolUse` guard: denies writes to frozen paths, reads of denied paths, and commands outside the whitelist |
| `scripts/gen-hooks.mjs` | Generates the `hooks.json` that mounts the guard, plus the `policy.json` it reads |
| `scripts/session-report.mjs` | Reads the delegate's durable session log into an audit of what it actually did |
| `scripts/differential.test.mjs` | Asserts this Node guard and the bash original decide every payload identically |
| `scripts/guard-paths.test.mjs`, `scripts/hooks-matcher.test.mjs`, `scripts/session-report.test.mjs` | Regression pins, one per defect that shipped: a path matcher that only spoke `/`, a matcher and a `switch` that disagreed, a report heading that read a path without normalising it |

The guard is the reason this directory holds scripts and not only prose. The
frozen-tests rule used to be enforced by asking the delegate nicely and checking
the diff afterwards; it is now enforced by refusing the tool call. One guard
serves both DeepSeek Harness and Codex, because both read the same
`tool_name` / `tool_input.file_path` payload and both treat exit 2 as a block.

## Why these are `.mjs` here and `.sh` in the operator's dotfiles

dsh runs command hooks through `ctx.shell`, which is **PowerShell on Windows**.
PowerShell cannot execute the `.sh` the bash generator emitted, so the hook
failed with a non-2 exit code — and the protocol says "Exit 2 blocks with
stderr; other failures are non-blocking". `hooks.json` looked correct and every
protection was off. That is the whole reason this plugin exists in Node.

The guard imports **only `node:` builtins**. It runs on every matched tool call
and is the security boundary; a missing `node_modules` must never be able to
disable it. Keep it that way.

The bash originals still exist in the operator's own dotfiles, because
`agy-invoke` and `codex-invoke` still use them. `differential.test.mjs` is what
stops the two drifting: it feeds both the same payloads and fails if they ever
disagree.

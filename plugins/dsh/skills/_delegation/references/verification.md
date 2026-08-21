<!-- VENDORED -- do not edit here
  upstream repo:   git@github.com:lanhp-vn/ubuntu-setup.git
  upstream path:   skills/_delegation/references/verification.md
  upstream commit: 1ee61e7
  vendored:        2026-08-21

  This file is a VERBATIM copy. Edit it upstream and re-run
  scripts/vendor-delegation.mjs; edits made here are drift, and
  vendor-delegation.mjs --check will fail.

  The scripts under scripts/ are NOT verbatim -- they are Node ports of bash
  originals, checked behaviourally by differential.test.mjs rather than by
  hash. README.md here is plugin-authored for the same reason.
-->

# The verification gate

Shared by all three skills. This is the step that makes delegation safe, and it
is the step under the most pressure to skip — cheap tokens tempt you to delegate
more and read less, and a confident summary reads like a finished job.

**The person who wrote the code should not be the only one who says it is
correct.** Tests are the contract; you hold the contract.

## The gate

1. **`git diff` and `git status --short`.** Both. Untracked files hide from
   `git diff`: a 146-file, 32 MB migration once reported as `1 file changed`
   because everything except `.gitignore` was untracked.
2. **Run the tests yourself.** Not "the delegate says they pass". Run the
   project's lint / build / typecheck too if it has them.
3. **`git diff -- <frozen paths>` must be empty.** If a test file changed, that
   is an automatic bounce: the delegate changed the contract instead of meeting
   it. This check is *not* made redundant by the `PreToolUse` guard — see below.
4. **Sanity-check the diff:** right files, no scope creep, no smuggled
   dependencies, no `# TODO` where logic should be.
5. **Audit the session log** where the backend produces one (see below).

## The guard does not replace step 3

`deepseek-run.sh` and the Codex hook config can block the direct route to editing
a frozen test. They do not make step 3 optional.

Measured 2026-08-15: a delegate blocked from editing a frozen test wrote a
`conftest.py`, let the whitelisted `pytest` command execute it, had that code
rewrite the frozen file, then deleted the helper. The guard log showed the block.
The file changed anyway. `git diff -- tests/` found it immediately.

Any whitelisted command that runs project code grants arbitrary code execution.
Treat the guard as an audit trail and a speed bump, never as the reason to skip
the diff.

## Auditing the session log (dsh backend)

`_delegation/scripts/session-report.sh` reads the delegate's durable log and
prints what it *actually* did: every tool call with its arguments, every guard
decision, and the token totals. This is the answer to the house failure mode,
which is **silent acceptance** — a bad model name falls back to a cheaper model,
a bad effort value is ignored, an image becomes placeholder text, and nothing
errors.

Read it for three things:

- **Tool calls that do not match the story.** The summary said it edited one
  file; the log shows four writes.
- **`exitCode` values that are neither 0 nor 2 on any hook.** That means the
  guard could not run and the call was allowed. The run was not guarded, whatever
  the config said. The reporter prints a warning for this.
- **Token totals**, which are the only honest cost figure. Reasoning bills at the
  output rate and usually dominates: one measured run spent 16.5k reasoning
  tokens out of 19.8k output.

## Verification vindicates as often as it catches

Do not treat every unrequested change as scope creep to revert on reflex.
Implementers report real work under mild labels — "minor behavior-preserving lint
cleanup", "removed an unused f-string prefix". In one run those two labels
covered removing two genuinely-unused imports, renaming a write-only local, and
**repairing two files that were outright `SyntaxError` under Python 3.12**. All
three were correct and the third was valuable; reverting on reflex would have
restored a file that cannot be imported.

Prove equivalence, then keep the change and say why in the commit.

Equally, a delegate that reports a sandbox workaround is telling you something
useful, not confessing a fault. Measured: `uv` cannot write `~/.cache/uv` under
`workspace-write`, so delegates redirect `UV_CACHE_DIR` into the workspace. That
note in a summary is a correctly-degraded run announcing itself.

## Verifying a mechanical transform: compare ASTs, not diffs

When the task is mechanical — a migration, a rename, a codemod — reading the diff
neither scales nor proves anything. A 146-file copy with 151 path replacements
produces a diff nobody checks honestly, and the one hunk that matters looks
exactly like the 900 that do not.

Instead, **apply the intended rewrite to the SOURCE yourself, then compare ASTs.**
Everything that was supposed to change cancels out; whatever still differs is a
real code change, and there are usually only a handful.

```python
import ast, re
REWRITES = [(r'scripts/oldname', 'scripts/newname'), ...]   # the intended transform
def norm(t):
    for a, b in REWRITES: t = re.sub(a, b, t)
    return t
same = ast.dump(ast.parse(norm(src.read_text()))) == ast.dump(ast.parse(dst.read_text()))
```

Measured on a real migration: 18 files compared, **15 AST-identical**, 3 needing
review — and all 3 were legitimate lint-driven cleanups. Five minutes instead of
an unreviewable diff.

- **Formatting is invisible to this check**, which is the point.
- **For functions and classes, compare bytecode** (`__code__.co_code`,
  `co_consts`, `co_names`), not `repr()`. A `repr()` embeds the module and a
  memory address, so it *always* differs between two separately-loaded copies —
  a guaranteed false positive that will send you chasing nothing.
- **A file that will not parse is itself the finding.**

## The delegate is a peer, not an authority

Push back on confident claims about library APIs, versions, or "best practices"
the same way you would with any implementer. Its knowledge cutoff may lag yours,
so it can be confidently wrong about recent releases. A wrong claim in a summary
is caught the same way a failing test is: verify, then bounce with specifics.

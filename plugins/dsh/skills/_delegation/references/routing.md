<!-- VENDORED -- do not edit here
  upstream repo:   git@github.com:lanhp-vn/ubuntu-setup.git
  upstream path:   skills/_delegation/references/routing.md
  upstream commit: 1ee61e7
  vendored:        2026-08-21

  This file is a VERBATIM copy. Edit it upstream and re-run
  scripts/vendor-delegation.mjs; edits made here are drift, and
  vendor-delegation.mjs --check will fail.

  The scripts under scripts/ are NOT verbatim -- they are Node ports of bash
  originals, checked behaviourally by differential.test.mjs rather than by
  hash. README.md here is plugin-authored for the same reason.
-->

# Which delegate gets this task

One home for the routing decision. `agy-invoke`, `codex-invoke` and
`deepseek-invoke` all cite this file rather than restating it, because three
copies of a routing table drift and the drift is invisible until two skills
contradict each other.

`deepseek-invoke` has been a Claude Code plugin since 2026-08-20 rather than a
sibling directory here; the routing decision below is unchanged by that. This
file is vendored into the plugin and hash-checked, so edit it HERE and re-run
the plugin's `scripts/vendor-delegation.mjs` — an edit made over there is drift.

## The table

| Reach for | When | What it is |
|---|---|---|
| **`agy-invoke`** | You need to *find out* something: explore, research, critique | Antigravity CLI (`agy`), read-only investigator with web search and a browser |
| **`deepseek-invoke`** | The spec is **already written** and a command proves it done | DeepSeek Harness (`dsh`), cheap per-token implementer |
| **`codex-invoke`** | The work is subtle, security-sensitive, or hard to test | Codex CLI, careful implementer on a subscription |

Picking wrongly is the most expensive mistake available here, and it is cheaper
to think for ten seconds than to bounce a bad delegation twice.

## The rule that does the most work

**If you cannot write the check that proves it done, do not delegate it to an
implementer.** A vague brief sent to any implementer returns confident, plausible
code, and the review time costs far more than the tokens saved. That rule decides
more cases correctly than any cost comparison below it.

When the hard part is *deciding what to build*, no implementer is the answer.
Either investigate first (`agy-invoke`), or do it yourself.

## Choosing between the two implementers

Both write code. The difference is what you pay and what you risk.

**`deepseek-invoke` earns its place on work that is well-specified and
voluminous:** implementing a plan you already wrote, mechanical refactors across
many files, test-suite fill-in, boilerplate, porting, format conversion, a first
draft you intend to review closely anyway. It bills per token with no
subscription, so waste is visible on the invoice — and it is genuinely cheap.
Measured 2026-08-15: seven delegations against a small repo cost **$0.03 total**,
around half a cent each on `flash`.

**`codex-invoke` earns its place when being wrong is expensive.** Subtle logic,
anything touching auth or money or user data, work where the test you can write
does not fully capture the requirement. You are paying for judgment, not volume.

A useful tiebreaker: if you would review the diff line by line anyway, the cheap
implementer is fine, because your review is the real quality gate. If you would
be tempted to skim because the change *looks* routine, that is exactly where the
careful implementer pays for itself.

## Judgment is never delegated

`agy` returns claims. Implementers return diffs. Neither returns a decision.

You verify citations on the way in and tests on the way out, and you own what
lands on disk. If you find yourself pasting an investigation's plan into a file
unread, or accepting a diff because its summary sounded confident, the division
of labour has quietly collapsed into "the model decided".

---
name: research
description: >-
  Send a DeepSeek delegate out to search the public web, open the pages, read
  them, and report back with sources — so Claude spends its context on judgement
  instead of on scrolling documentation. Use this whenever the user says
  "/dsh:research", "research this", "look this up", "find the official docs for",
  "what does the changelog say", "search github for", "is this API deprecated",
  "what's the current version of", "how do you do X in <library>", or asks a
  question whose honest answer is "I'd have to check the docs". ALWAYS prefer it
  over answering from memory when the subject is a library, framework, API,
  CLI, package version, pricing page or release note — those move faster than
  any training cut-off, and a confidently wrong version number costs more than
  the cent this spends. Also use it before briefing a delegate against an
  unfamiliar dependency, so the brief describes the API that actually exists.
  Do NOT use it to read code in the current repository (that is ordinary
  reading), for questions with no external source of truth, or when the user
  wants Claude's own reasoning rather than what a document says.
---

# `/dsh:research` — the delegate reads, you keep the judgement

The delegate does the expensive, low-judgement part: issue many searches, open
many pages, and pull out the passages that answer the question. Claude does the
part that needs judgement: decide what was actually established, what is still
unknown, and what to tell the user.

The economics are the whole point. Reading six documentation pages costs a few
thousand tokens of DeepSeek flash and about a cent. Reading them in Claude's
context costs the context — and context spent on a changelog is context not
spent on the user's actual problem.

## This is the one delegation that touches the network

Every other dsh run is network-mute by construction: the wrapper writes
`fetch: false` into `tool-web`, so the `web_fetch` tool is never registered.
`/dsh:research` passes `--web-fetch`, which is the only thing that turns it on,
and it is a flag rather than a repo setting on purpose — it lives in a hand and
in the session log, so nothing arrives with a `git clone`.

With fetch on, the guard starts policing URLs: `web_fetch` joins the hook
matcher and any loopback, link-local, RFC1918, CGNAT, unique-local or cloud
metadata target is refused, as is any scheme that is not http(s). A page the
delegate reads can contain a link; that link is not trusted just because the
delegate followed it.

**What that does not cover, stated plainly.** The rule reads the URL as written.
It does not resolve DNS, so a hostname that points at a private address passes,
and a redirect from a public host to a private one happens inside the fetch
backend after the hook has returned. It stops the literal and the careless,
which is the realistic shape of the risk. Treat a research run as
network-adjacent, not network-isolated, and do not run one on a machine whose
LAN you would mind a stranger probing.

## Running it

Point it at a scratch directory, never the user's repo. Research produces a
report, not edits, and the sandbox confines writes to the workspace root — so a
throwaway root means there is nothing of the user's to damage even if the
delegate decides to take notes.

```bash
SCRATCH=$(mktemp -d)
node <plugin-root>/scripts/deepseek-run.mjs -C "$SCRATCH" --web-fetch \
  --max-turns 24 "<the research brief>"
```

Resolve `<plugin-root>` with the glob `~/.claude/plugins/cache/dsh/dsh/*/`
or use `plugins/dsh/` in a checkout. Do not pass `--allow-test`: research needs
no shell, and not granting one is cheaper than policing one.

Raise `--max-turns` for a broad survey and lower it for a single lookup; each
turn is a search or a fetch, and a question with one obvious source rarely needs
more than six.

## Briefing it

The delegate is good at fetching and bad at knowing when to stop. A brief that
names the question, the kind of source that would settle it, and the stopping
condition gets a usable answer; a brief that says "research X" gets a tour.

State four things:

- **The question**, specifically enough that an answer can be wrong. "Does
  `pandas.DataFrame.append` still exist in pandas 3.x, and what replaced it"
  beats "research pandas append".
- **What would settle it** — the official docs, the changelog, the release
  notes, the actual source file on GitHub. Naming the kind of source steers it
  away from content-farm restatements.
- **What to bring back**: for every claim, the URL, the publication or version
  it belongs to, and a short verbatim quote of the sentence it rests on.
- **When to stop**: "three independent sources agree" or "the official doc
  answers it" — otherwise it keeps going until the turn limit.

Ask for the uncertainty explicitly. A delegate told "say plainly when the
sources disagree or do not cover it" will do so; one told only to answer will
fill the gap. That instruction is worth more than any other sentence in the
brief.

## Reading what comes back

**The report is a claim about documents, not a document.** The delegate read the
pages and you did not, so treat its summary the way you would treat a colleague's
— useful, probably right, and worth spot-checking where it matters.

Check the quotes it returns against the URLs it cites, at least for anything the
user will act on: a version number, a deprecation, a security claim, an API
signature. A fabricated citation looks exactly like a real one until fetched.
When a claim is load-bearing and the quote looks thin, fetch that one page
yourself — one page is cheap; being confidently wrong is not.

Two failure shapes worth recognising:

- **Snippet-only answers.** If the report cites search-result summaries rather
  than page text, the fetches failed or were never attempted, and the answer is
  built on blurbs. Check the session log for `web_fetch` calls.
- **A confident answer with one source.** Fine for an official doc, weak for
  anything else. Say which it was.

## Reporting to the user

Every claim carries three things, because a research answer that cannot be
audited is just a fluent guess:

- **Source** — the URL, and what it is (official doc, registry, maintainer
  comment, third-party post).
- **Date** — when it was checked, and the version or date the source itself
  carries. This repo's convention is "Measured YYYY-MM-DD"; research findings
  follow it.
- **Tier** — how much weight it holds:

| Tier | What it is | How to treat it |
|---|---|---|
| 1 | Official docs, the package registry, the project's own changelog or release notes, source in the canonical repo | Can be stated as fact, with the date |
| 2 | Maintainer statements in issues, PRs, or commit messages | Reliable about intent; may describe something unreleased |
| 3 | Third-party posts, Stack Overflow, blogs, AI-generated docs sites | A lead to verify, never the basis for a claim |

When tiers disagree, say so and name which you believe. When nothing above tier
3 was found, say *that* — "the only sources are blog posts" is a real finding
and often the most useful sentence in the report.

Separate **what the sources establish** from **what you infer from them**. The
inference may well be right, but the user needs to know which is which, because
only one of them has a URL behind it.

## It reports; it does not act

This skill is read-only by design. It never edits files, installs anything,
bumps a pin, or changes configuration — not because a delegate could not, but
because research and action want different amounts of scrutiny. Findings flow
into a decision the user makes, or into `/dsh:update` and `/dsh:tools-check`,
which already carry the verification that acting requires.

If the research concludes "we should upgrade X", say so and stop. That is the
answer, and the doing is a separate, deliberate step.

## Cost

A focused lookup is a few thousand tokens of flash — well under a cent. A broad
survey with a high turn limit can reach a few cents. Both are cheaper than the
context the same reading would consume, which is the real reason to delegate it.

<!-- Vendored into this plugin from lanhp-vn/ubuntu-setup
     skills/deepseek-invoke/references/deepseek-api.md on 2026-08-20.
     Script names were rewritten .sh -> .mjs: the plugin's scripts are
     Node ports, and dsh runs hooks through PowerShell on Windows where
     a .sh cannot execute. Every measured claim below is unchanged. -->

# DeepSeek API: verified facts

Every claim here was read from the primary source or confirmed with a live call
on **2026-08-09**. DeepSeek renames models and changes prices often, so treat
anything undated as suspect and re-check before relying on it. Items marked
UNVERIFIED could not be confirmed against a primary source; carry the label
forward rather than quietly promoting them to fact.

## Models

Updated **2026-09-10** from <https://api-docs.deepseek.com/updates/> and the
pricing page. The table below replaced a `pro`/`flash` pair; read the
retirements underneath it before using any other id.

| Model ID | Use | Context | Max output | Reasoning |
|---|---|---|---|---|
| `deepseek-flash` | **the only current model** (V4.1-Flash); native multimodal vision | 1M | 384K | yes |

DeepSeek's own release note: *"After extensive testing, V4.1 Flash has
comprehensively surpassed V4 Pro."*

Retirements, newest first — **four id changes in under three months**, so treat
any model id you did not read off the docs page today as suspect:

| Id | Status |
|---|---|
| `deepseek-v4-pro` | **retires 2026-09-14**; after that its requests route to V4.1-Flash and bill at the flash price |
| `deepseek-v4-flash` | legacy alias, "temporarily routed" to V4.1-Flash |
| `deepseek-v4-flash-vision-exp` | legacy alias, "temporarily routed" to V4.1-Flash |
| `deepseek-chat`, `deepseek-reasoner` | **discontinued 2026-07-24** (announced 2026-04-24) |

Any guide still using the discontinued names is stale, which is a useful
staleness test for third-party blog posts and tool docs.

**There is no `[1m]` suffix any more.** This file previously said to add one
(`deepseek-v4-pro[1m]`) to select the 1M-context variant through the
Anthropic-compatible endpoint. As of 2026-09-10 the pricing page lists **no**
separate variant id, `deepseek-flash` carries 1M context on its own, and
DeepSeek's Anthropic guide spells the id bare in its own example. `deepseek-run.mjs`
writes the unsuffixed id on both backends.

Source: <https://api-docs.deepseek.com/updates/>, <https://api-docs.deepseek.com/api/create-chat-completion>

## Endpoints

| Format | Base URL |
|---|---|
| OpenAI Chat Completions | `https://api.deepseek.com` (**no `/v1`**) |
| OpenAI Responses | `https://api.deepseek.com` |
| Anthropic Messages | `https://api.deepseek.com/anthropic` |

The Anthropic endpoint maps Claude names onto DeepSeek automatically. Read
2026-09-10: Opus → `deepseek-v4-pro`, Sonnet/Haiku → `deepseek-flash` — and
since pro's requests route to V4.1-Flash from 2026-09-14, every Claude name
lands on the same model after that date. An unrecognised model name silently
falls back to flash, so a typo downgrades the model rather than raising an
error; `deepseek-run.mjs` sets all three `ANTHROPIC_*_MODEL` variables
explicitly rather than relying on the mapping.

## Thinking mode

`thinking` is an **object**, not a boolean:

```json
{
  "model": "deepseek-flash",
  "messages": [{"role": "user", "content": "..."}],
  "thinking": {"type": "enabled"},
  "reasoning_effort": "high"
}
```

- `reasoning_effort`: `low` | `high` (default) | `max`.
- **UNVERIFIED against `deepseek-flash`.** The docs said `deepseek-v4-pro`
  supported only `high` and `max`, and a live test on 2026-08-09 showed `low`
  was silently accepted on pro — no error, no warning. `deepseek-run.mjs` used
  to reject `low` client-side for that reason; that check was **removed with
  the model** on 2026-09-10 rather than re-pointed at flash, because the docs
  do not say what flash does with an effort value and re-asserting an
  unverified constraint would be a guess dressed as a measurement. Confirm from
  the session log what a run actually did.
- Chain-of-thought comes back in a separate `reasoning_content` field.
- With thinking on, `temperature`, `top_p`, `presence_penalty` and
  `frequency_penalty` are silently ignored (UNVERIFIED: reported in research,
  not confirmed by live test).

## Cost

Per 1M tokens, USD, re-read from the pricing page **2026-09-10**. Prices are now
quoted per-period, and the off-peak/peak spread is 2x — the earlier single-column
figures below it (read 2026-08-09) did not distinguish them:

| Model | Input (cache miss) | Input (cache hit) | Output |
|---|---|---|---|
| `deepseek-flash` off-peak | $0.15 | $0.003 | $0.60 |
| `deepseek-flash` peak | $0.30 | $0.006 | $1.20 |
| `deepseek-v4-pro` off-peak (retiring 2026-09-14) | $0.66 | $0.022 | $1.98 |
| `deepseek-v4-pro` peak (retiring 2026-09-14) | $1.32 | $0.044 | $3.96 |

Note the direction of travel: flash's own output price went from $0.28 to $0.60
off-peak between 2026-08-09 and 2026-09-10, so the pricing-page warning below
is not hypothetical — it already happened, roughly doubling.

The pricing page carries its own warning: *"We plan to raise the overall pricing
for DeepSeek API services in the near future, with a significant increase
expected."* Re-read the page before quoting these numbers to anyone.

**Reasoning tokens bill at the output rate.** Verified live: a request whose
visible answer was the two characters `OK` reported `completion_tokens: 29`, of
which `reasoning_tokens: 27`. On a short answer the thinking *is* the bill, so
`max` effort on a trivial task is close to pure waste.

**Context caching is automatic and needs no configuration.** It matches on an
exact prefix from token 0, so any change near the top of a prompt: a timestamp,
a reordered file, or a changed preamble, invalidates everything after it. Keep the
stable material first and the varying material last. The `usage` object reports
`prompt_cache_hit_tokens` and `prompt_cache_miss_tokens`; a cache hit costs
about 1% of a miss, which is the single biggest cost lever available.

No free tier. Balance is readable at `GET https://api.deepseek.com/user/balance`.

Source: <https://api-docs.deepseek.com/quick_start/pricing/>, <https://api-docs.deepseek.com/guides/kv_cache>

UNVERIFIED: research reported a 2x peak-hour multiplier (Beijing 09:00-12:00 and
14:00-18:00, UTC+8, weekdays) and per-account concurrency ceilings of 500 (pro)
and 2500 (flash). Neither appeared on any page read directly.

## No image input, anywhere, and it fails silently

This is the trap worth remembering, because nothing errors:

| Surface | Behaviour |
|---|---|
| Chat Completions | `content` accepts a **string only** |
| Anthropic-compatible | `array, type='image'` → *"Not Supported"* |
| Responses API | *"`input_image` parts do not cause an error, but are replaced with a placeholder text"* |

So an image sent to DeepSeek yields a confident answer about content the model
never saw. Third-party posts claiming DeepSeek vision are conflating the
**open-weights** DeepSeek-OCR line, which you would have to self-host, with the
hosted API. The efficiency figures quoted for that architecture are not
reachable through the API you are paying for.

Practical consequence: whoever supervises the delegation should read images
themselves and hand DeepSeek text. See `SKILL.md` (Images).

Source: <https://api-docs.deepseek.com/guides/responses_api/>, <https://api-docs.deepseek.com/guides/anthropic_api>

## Running an agentic coding loop on DeepSeek

**Superseded 2026-08-15. DeepSeek now publishes its own harness.** This section
used to open "DeepSeek publishes no coding CLI of its own", which was true until
2026-08 and is now wrong — a good reminder of how quickly this file goes stale.

- **DeepSeek Harness (`dsh`)** → the first-party option, `npm i -g
  @deepseek-ai/dsh`, one-shot mode `dsh --profile headless "<task>"`. This is what
  `deepseek-run.mjs` uses by default. Full details, all measured, in
  [`dsh.md`](dsh.md).
- **Claude Code** → set `ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic`
  plus an auth token and model names. Still works, still needs nothing installed
  beyond the CLI already present, and is kept as `--backend claude-code` because
  `dsh` is a developer preview promising breaking changes.
- **Codex CLI** → needs a **forwarding proxy** (DeepSeek's guide uses Moon
  Bridge, requiring Go 1.25+), because Codex speaks the Responses API in a shape
  DeepSeek does not serve directly. Its setup also **overwrites
  `~/.codex/config.toml`**, which would break an existing Codex setup. Avoid
  unless there is a specific reason.
- Others documented: Aider, Cline, OpenCode, Qwen Code, Kilo Code, Crush,
  DeepSeek-TUI, Reasonix.

The index itself: <https://github.com/deepseek-ai/awesome-deepseek-agent>, with
the Claude Code recipe at `docs/claude_code.md`. The harness itself is at
<https://github.com/deepseek-ai/deepseek-harness> and is pinned as a submodule at
`references/deepseek/deepseek-harness` in the ops-marcom-management repo
(commit `47f9438`; moved there from system-settings on 2026-08-17).

Note for this Ubuntu host specifically: `codex` **is** installed
(`~/.local/bin/codex`) and `codex-invoke` is a live skill, so the warning above
about DeepSeek's Codex setup clobbering `~/.codex/config.toml` is a real risk
here, not a hypothetical one.

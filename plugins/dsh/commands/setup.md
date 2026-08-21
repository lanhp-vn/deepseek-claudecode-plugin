---
description: Wire a DeepSeek API key into this machine, verify it, and scaffold ~/.deepseek/machine.yml
---

Run the setup script and report what it says:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/setup-deepseek.mjs --dsh
```

If the user supplied a key in their message, pass it: `--key sk-...`. If they
named a file, use `--from <path>`. Otherwise the script finds an existing key
from `$DEEPSEEK_API_KEY` or `~/.deepseek/api-key`.

**Never echo the key.** The script prints a masked fingerprint (`sk-abcd...wxyz`)
and so should you. If the user pasted a key into the conversation, tell them it
is now in their transcript and that rotating it is cheap.

## Doctor mode

To check an existing setup without writing anything:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/setup-deepseek.mjs --verify-only
```

That reports Node's version and platform, which shell dsh will run hooks
through, whether the key is accepted, the available models, and the balance.
Reach for it first when a delegation fails in a confusing way — a `402` is an
empty balance, not a bad brief, and there is no free tier.

## What it writes

| Path | Why |
|---|---|
| `~/.deepseek/api-key` (0600) | the claude-code backend reads this |
| `$DSH_HOME/.credentials.yaml` (0600), with `--dsh` | keeps the key out of `process.env`, so it is not handed to every subprocess |
| `~/.deepseek/machine.yml` | scaffold only; **never clobbered** if it already exists |

`machine.yml` is where per-machine paths live, referenced from a repository's
committed `.deepseek/overlay.yml` as `${machine.<key>}`. It is scaffolded with
every documented key commented out and empty, because a guessed path would mount
a language server that silently does nothing — whereas a missing key is a clear
error naming the key.

**`machine.yml` must never be committed.** It is per-machine by definition.

#!/usr/bin/env node
// delegation-guard.mjs: a PreToolUse hook shared by the dsh and Codex delegates.
//
// Reads a Claude-Code-shaped hook payload on stdin and decides one tool call:
//   exit 2  -> BLOCK, reason on stderr    (the block signal in BOTH dialects)
//   exit 0  -> allow
//   anything else -> the harness treats it as a NON-BLOCKING error and ALLOWS.
//
// That last line is the whole reason this script is defensive. Measured
// 2026-08-15: with the guard placed outside the sandboxed workspace the hook
// ran, exited 127 ("No such file or directory"), and the bridge recorded
// `decision: pass` for every call. The run looked guarded and was not. So:
//   * every unexpected condition exits 2 (fail CLOSED), never 0;
//   * the generator must install this file INSIDE the workspace root; and
//   * the run report must assert no hook/result carried exitCode 127.
//
// This file is the Node port of delegation-guard.sh, and exists because dsh
// executes command hooks through ctx.shell -- PowerShell on Windows -- which
// cannot run the .sh. There the hook fails with a non-2 code, the harness
// treats that as non-blocking, and every protection is silently off.
//
// ZERO DEPENDENCIES. Only node: builtins are imported. A missing node_modules
// must never be able to disable the security boundary.
//
// WHAT THIS DOES NOT DO. It blocks the direct route only. A delegate that is
// allowed to run a command which executes project code -- pytest reading
// conftest.py, `npm test` running scripts, make -- can have THAT code edit a
// frozen file. Measured: a delegate did exactly this, then deleted the helper.
// `git diff -- <frozen>` caught it. This guard raises the cost and leaves an
// audit trail; the diff is still the thing that holds.
//
// Policy comes from policy.json, resolved as a sibling of this file:
//   frozen    paths that must not be WRITTEN (but must stay readable)
//   allowCmd  the single permitted command; empty means "do not police bash"
//   denyPath  path globs that must not be read OR written (secrets)
//   denyCmd   command patterns that must not run, in a shell or a PTY
//   denyTool  tool NAMES that may never be called at all -- the only rule that
//             covers MCP tools, whose names are data (`mcp__<server>__<tool>`)
//             rather than a fixed vocabulary the other branches can enumerate
//
// The three deny rules are additive and OPTIONAL: with all empty this behaves
// exactly as it did before they existed, so the codex and agy delegations that
// share this guard are unaffected.
//
// WHAT DENY_PATH DOES NOT COVER. It matches the path a tool NAMES. A `grep`
// with no path argument searches the tree and can return matching lines from a
// denied file; a bash command is only substring-scanned. The primary control
// for secrets is therefore to delegate in a git worktree, where a gitignored
// credentials directory does not exist at all -- this is the second layer.
import { readFileSync } from 'node:fs'
import { dirname, join, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const die = (msg) => { console.error(msg); process.exit(2) }

// No policy means no decision, and no decision must not mean "allow".
let policy
try {
  policy = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'policy.json'), 'utf8'))
} catch {
  die('delegation-guard: cannot read policy.json; blocking')
}
// WINDOWS PATHS ARRIVE WITH BACKSLASHES AND EVERY MATCHER HERE SPEAKS `/`.
//
// Measured 2026-08-21, on the first live run of dsh-doctor: dsh's `write` tool
// sends an ABSOLUTE file_path, so a frozen `contract.txt` was compared against
// `C:\...\workspace\contract.txt`. `target.endsWith('/contract.txt')` is false
// there, and the guard returned exit 0 -- ALLOW. The frozen rule and every
// denyPath rule were silently off for absolute paths on Windows; only a
// delegate that happened to send a relative path was ever refused, which is why
// the 2026-08-20 check passed. Nothing in the config looked wrong, again.
//
// Normalise once, at the boundary, so the matchers keep their single vocabulary
// instead of each one learning about separators. On POSIX a backslash is a
// legal filename character, so `a\b.txt` now reads as `a/b.txt` and can match
// a frozen `b.txt`: a false block on a pathological name, which costs one
// bounced tool call, against a false allow, which costs the contract.
const slash = (p) => String(p ?? '').split('\\').join('/')

const frozen = (policy.frozen ?? []).map(slash)
const allowCmd = policy.allowCmd ?? ''
// Comparisons run against this stripped form; error messages still show
// allowCmd verbatim. Without this, an --allow-test value that itself starts
// with VAR=value (e.g. `UV_NO_SYNC=1 uv run pytest ...`) can never match,
// because the probe below strips ALL leading assignments while allowCmd kept
// its own -- a prefix check comparing a stripped string against an
// unstripped one that is always false. Measured 2026-09-07.
const stripLeadingAssignments = (s) => {
  let out = s
  let m
  while ((m = out.match(/^[A-Za-z_][A-Za-z0-9_]*=\S*\s+/))) out = out.slice(m[0].length)
  return out
}
const allowCmdCore = stripLeadingAssignments(allowCmd)
const denyPath = (policy.denyPath ?? []).map(slash)
const denyCmd = policy.denyCmd ?? []
const denyTool = policy.denyTool ?? []
const webFetch = policy.webFetch === true

/**
 * Every spelling of an IPv4 literal that resolvers and curl all accept:
 * dotted-quad, bare decimal (2130706433), octal (0177.0.0.1), hex (0x7f.0.0.1),
 * and the short forms that pack the remainder into the last part (127.1).
 * Returns the four octets, or null when this is not an IPv4 literal at all.
 *
 * Spelled out rather than regex-matched on `127.` because the alternate
 * encodings are precisely how a naive check gets walked past.
 */
function ipv4Parts (host) {
  const raw = host.split('.')
  if (raw.length === 0 || raw.length > 4) return null
  const nums = []
  for (const p of raw) {
    if (p === '') return null
    let n
    if (/^0[xX][0-9a-fA-F]+$/.test(p)) n = parseInt(p, 16)
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8)
    else if (/^[0-9]+$/.test(p)) n = parseInt(p, 10)
    else return null
    if (!Number.isFinite(n) || n < 0) return null
    nums.push(n)
  }
  let value
  if (nums.length === 1) value = nums[0]
  else {
    const last = nums[nums.length - 1]
    const lead = nums.slice(0, -1)
    if (lead.some((n) => n > 255)) return null
    const room = 8 * (4 - nums.length + 1)
    if (last >= 2 ** room) return null
    value = lead.reduce((acc, n) => acc * 256 + n, 0) * (2 ** room) + last
  }
  if (!Number.isFinite(value) || value < 0 || value > 0xFFFFFFFF) return null
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255]
}

/**
 * Is this host somewhere a PUBLIC-documentation fetch has no business going?
 * Unknown/unparseable resolves to "private" -- the fail-closed direction, since
 * the whole point is that only recognisably public hosts are worth reading.
 */
function isPrivateHost (host) {
  if (!host) return true
  const h = host.replace(/\.$/, '')              // a trailing dot is still an FQDN
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa')) return true
  // IPv4-mapped IPv6. WHATWG URL rewrites ::ffff:127.0.0.1 into the HEX form
  // ::ffff:7f00:1 (measured 2026-09-10), so matching only the dotted spelling
  // let loopback through as an ordinary IPv6 address -- caught by the test, not
  // by reading the code. Both spellings are handled here.
  const mappedHex = h.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i)
  const mappedDot = h.match(/^::(?:ffff:)?((?:[0-9]{1,3}\.){3}[0-9]{1,3})$/i)
  let embedded = null
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16)
    const lo = parseInt(mappedHex[2], 16)
    embedded = [(hi >>> 8) & 255, hi & 255, (lo >>> 8) & 255, lo & 255]
  }
  const q = embedded ?? ipv4Parts(mappedDot ? mappedDot[1] : h)
  if (q) {
    const [a, b] = q
    if (a === 0 || a === 127) return true                 // this-network, loopback
    if (a === 10) return true                             // RFC1918
    if (a === 172 && b >= 16 && b <= 31) return true      // RFC1918
    if (a === 192 && b === 168) return true               // RFC1918
    if (a === 169 && b === 254) return true               // link-local AND cloud metadata
    if (a === 100 && b >= 64 && b <= 127) return true     // CGNAT
    if (a >= 224) return true                             // multicast, reserved
    return false
  }
  if (h.includes(':')) {                                   // an IPv6 literal
    const bare = h.replace(/%.*$/, '')                     // drop a zone id
    if (bare === '::' || bare === '::1') return true
    if (/^f[cd]/i.test(bare)) return true                  // unique-local fc00::/7
    if (/^fe[89ab]/i.test(bare)) return true               // link-local fe80::/10
    return false
  }
  return false                                             // an ordinary public name
}

let payload = ''
try { payload = readFileSync(0, 'utf8') } catch { die('delegation-guard: cannot read stdin; blocking') }

let d
try { d = JSON.parse(payload) } catch { die('delegation-guard: unparseable hook payload; blocking') }
const tool = typeof d?.tool_name === 'string' ? d.tool_name : ''
// Checked once, up front. An empty tool_name would otherwise look like "not a
// tool I police" and sail through every branch below.
if (!tool) die('delegation-guard: unparseable hook payload; blocking')
const arg = (k) => { const v = d?.tool_input?.[k]; return typeof v === 'string' ? v : '' }

const escapeRe = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&')

// --- glob matching, no dependency ------------------------------------------
// PATH globs: `**` crosses separators, `*` does not, `?` is one non-separator
// character. Used for denyPath, whose entries name files and directories.
function pathGlobToRe (g) {
  let re = ''
  for (let i = 0; i < g.length; i++) {
    const c = g[i]
    if (c === '*') {
      if (g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++ } else re += '[^/]*'
    } else if (c === '?') re += '[^/]'
    else re += escapeRe(c)
  }
  return new RegExp(`^${re}$`)
}

// COMMAND globs: `*` matches anything at all, separators and newlines included.
// This is NOT the path translator, and the difference is load-bearing. bash
// matched denyCmd entries with `case`, where `*` crosses `/`. Measured
// 2026-08-20, reusing the path translator here:
//   entry `adb * shell reboot` vs `/usr/bin/adb -s /dev/ttyUSB0 shell reboot`
//   bash -> exit 2 ; path-glob port -> exit 0, FAILING OPEN.
// Every denyCmd entry with an interior `*` and no leading one was affected.
// `adb * shell reboot` is live in the SL2619-NPU deny set, whose board drives
// an arm near a patient's face.
function cmdGlobToRe (g) {
  return new RegExp(`^${escapeRe(g).replace(/\*/g, '[\\s\\S]*').replace(/\?/g, '[\\s\\S]')}$`)
}

// The longest glob-free segment of a deny entry, used to substring-scan free
// text (a bash command line, an apply_patch body) where glob matching does not
// apply. `credentials/**` -> credentials ; `**/*.enc` -> .enc ; `*` -> empty.
//
// The bash original split this with an unquoted `for`, which globs each word
// after splitting, so `**` expanded against the delegate's working directory
// and the answer became the longest FILENAME there. Fixed there 2026-08-20;
// JS string splitting has no such hazard, but the tests pin it either way.
function literalOf (entry) {
  let best = ''
  for (const seg of entry.split('/')) {
    const cand = seg.replace(/^\*\*/, '').replace(/^\*/, '')
    if (!cand || /[*?[]/.test(cand)) continue
    if (cand.length > best.length) best = cand
  }
  return best
}

// A deny entry is a path or glob: `credentials/**`, `.env`, `**/*.enc`.
// Matching is deliberately generous -- the target is denied when it matches the
// entry as a glob, matches it under any parent (a relative path), or lives
// beneath a directory the entry names. A false block costs one bounced tool
// call and a log line; a false allow costs a credential.
function pathDenied (target) {
  if (!target || !denyPath.length) return false
  for (const e of denyPath) {
    const re = pathGlobToRe(e)
    const parts = target.split('/')
    if (parts.some((_, i) => re.test(parts.slice(i).join('/')))) return true
    const base = e.replace(/\/\*\*$/, '').replace(/\/$/, '')
    if (base && !/[*?[]/.test(base)) {
      if (target === base || target.startsWith(`${base}/`) ||
          target.endsWith(`/${base}`) || target.includes(`/${base}/`)) return true
    }
  }
  return false
}

// Substring-scan free text for any denied path's literal segment.
function textHitsDenyPath (text) {
  if (!text || !denyPath.length) return false
  return denyPath.some((e) => { const l = literalOf(e); return l && text.includes(l) })
}

// Matched as a literal substring AND as a command glob, so both
// `distil model run-training` and `adb * shell reboot` behave as written.
function cmdDenied (text) {
  if (!text || !denyCmd.length) return false
  return denyCmd.some((e) => text.includes(e) || cmdGlobToRe(`*${e}*`).test(text) || cmdGlobToRe(e).test(text))
}

// ---------------------------------------------------------------------------
// 1. Tool-name deny. Checked before anything else and independently of every
// other rule, because it is a statement about capability rather than about
// arguments.
//
// This exists for MCP. Measured 2026-08-19: the gitnexus MCP server registers
// `rename`, `cypher` and `group_sync` -- graph MUTATIONS. Claude Code refuses
// them through `permissions.deny` in settings.json, but that is a Claude Code
// mechanism and a dsh delegate never sees it, so mounting the MCP client hands
// a delegate three write tools the repo's own AGENTS.md says are denied. The
// env vars that look like they cover this (GITNEXUS_MCP_READ_ONLY,
// GITNEXUS_MCP_ALLOWED_REPOS) are read by NOTHING in gitnexus 1.6.9 -- verified
// by grepping its dist for zero hits. So the deny has to live here.
// ---------------------------------------------------------------------------
if (denyTool.includes(tool)) {
  die(`BLOCKED: the tool '${tool}' is not available for this task. It mutates shared state that is read-only for a delegate.`)
}

// ---------------------------------------------------------------------------
// 1b. web_fetch, when the operator opted in with --web-fetch.
//
// Ordinary runs never reach this: the wrapper writes `fetch: false` into
// tool-web, the tool is not registered, and no web_fetch call can exist. A
// research delegation turns it on, which hands the delegate a fetch backend
// that does NOT itself refuse private-network targets -- so a link in a search
// result, or text on a fetched page, can steer it at a cloud metadata endpoint
// (169.254.169.254), a service on localhost, or the operator's LAN. The model is
// not the adversary here; a page it reads might be.
//
// WHAT THIS DOES NOT COVER, stated plainly because a partial control that is
// believed is worse than none: it reads the URL as written and does not resolve
// DNS, so `http://internal.example.com` pointing at 10.0.0.5 passes, and a
// redirect from a public host to a private one is not seen -- the fetch backend
// follows it after this hook has already returned. It stops the literal and the
// careless, which is the realistic shape of the risk, and nothing more. Treat a
// research delegation as network-adjacent, not network-isolated.
// ---------------------------------------------------------------------------
if (webFetch && (tool === 'web_fetch' || tool === 'WebFetch')) {
  const raw = String(arg('url') ?? '').trim()
  if (!raw) die('BLOCKED: web_fetch without a url.')
  let host = ''
  let scheme = ''
  try {
    const u = new URL(raw)
    scheme = u.protocol.toLowerCase()
    // Strips the [] of an IPv6 literal and any :port, and lowercases once.
    host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    die(`BLOCKED: web_fetch url is not parseable: ${raw}`)
  }
  // file:, gopher:, ftp: and friends are not research; http(s) is the whole job.
  if (scheme !== 'http:' && scheme !== 'https:') {
    die(`BLOCKED: web_fetch is limited to http and https for this task; got '${scheme}${scheme.endsWith(':') ? '' : ':'}'.`)
  }
  if (isPrivateHost(host)) {
    die(`BLOCKED: '${host}' is a loopback, link-local, private or metadata address. A research delegation reads PUBLIC documentation; it has no business inside this machine or network.`)
  }
}

// ---------------------------------------------------------------------------
// 2. Deny pre-pass. Runs BEFORE the frozen/allowlist logic and independently of
// it: a deny must apply even when --allow-test was never passed, because a docs
// or ops delegation polices no bash command at all yet must still not read
// secrets.
// ---------------------------------------------------------------------------
if (denyPath.length || denyCmd.length) {
  switch (tool) {
    case 'read': case 'Read': case 'write': case 'edit': case 'str_replace_editor':
    case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit': {
      const t = slash(arg('file_path') || arg('path'))
      if (pathDenied(t)) {
        die(`BLOCKED: ${t} is a denied path (secrets or protected state). It is out of scope for this task; do not read, write or copy it.`)
      }
      break
    }
    // glob's `pattern` IS a path glob, so it is checked too -- measured
    // 2026-08-19, `glob {pattern: "credentials/**"}` carried no `path` argument
    // and listed a denied directory unopposed. grep's `pattern` is a CONTENT
    // regex and is deliberately NOT checked: in a docs repo, searching for the
    // word "credentials" is ordinary work, and blocking it would be a false
    // positive on the common case. A pathless grep therefore stays uncovered --
    // see the header, and delegate in a worktree.
    case 'glob': case 'Glob':
      if (pathDenied(slash(arg('path'))) || pathDenied(slash(arg('pattern')))) {
        die('BLOCKED: that glob targets a denied path (secrets or protected state); do not enumerate it.')
      }
      break
    case 'grep': case 'Grep':
      if (pathDenied(slash(arg('path')))) {
        die(`BLOCKED: ${arg('path')} is a denied path (secrets or protected state); do not search it.`)
      }
      break
    case 'apply_patch':
      if (textHitsDenyPath(arg('command'))) {
        die('BLOCKED: this patch touches a denied path (secrets or protected state).')
      }
      break
    case 'bash': case 'Bash': case 'pwsh': {
      const c = arg('command')
      if (cmdDenied(c)) {
        die(`BLOCKED: this command matches a forbidden pattern for this repository. It is an operator action, not an agent action -- print it and stop. Got: ${c}`)
      }
      if (textHitsDenyPath(c)) {
        die(`BLOCKED: this command names a denied path (secrets or protected state). Got: ${c}`)
      }
      break
    }
    // terminal_send carries the shell input in `text` (verified against the dsh
    // tool catalog). Without this row a mounted PTY walks straight past every
    // deny rule, which is the whole reason the PTY weakens --allow-test.
    case 'terminal_send': {
      const c = arg('text')
      if (cmdDenied(c)) {
        die(`BLOCKED: this terminal input matches a forbidden pattern for this repository. It is an operator action, not an agent action -- print it and stop. Got: ${c}`)
      }
      if (textHitsDenyPath(c)) {
        die(`BLOCKED: this terminal input names a denied path (secrets or protected state). Got: ${c}`)
      }
      break
    }
    case 'terminal_open':
      if (pathDenied(slash(arg('cwd')))) {
        die(`BLOCKED: ${arg('cwd')} is a denied path; do not open a shell there.`)
      }
      break
  }
}

// ---------------------------------------------------------------------------
// 3. Frozen files and the command allowlist.
// ---------------------------------------------------------------------------
switch (tool) {
  // dsh: write/edit (tool-fs), str_replace_editor. Claude Code / Codex:
  // Write/Edit/... `read` is deliberately absent: the delegate MUST be able to
  // read the contract. This is the one place the frozen rule and the deny rule
  // disagree, and they disagree on purpose.
  case 'write': case 'edit': case 'str_replace_editor':
  case 'Write': case 'Edit': case 'MultiEdit': case 'NotebookEdit': {
    const target = slash(arg('file_path') || arg('path'))
    if (!target) process.exit(0)
    for (const f of frozen) {
      const b = basename(f)
      // Match the full path, or the basename, so a relative-path write is
      // caught too.
      if (target === f || target === b || target.endsWith(`/${b}`)) {
        die(`BLOCKED: ${target} is a frozen test file. Read it; do not edit it. If the test looks wrong, stop and explain instead of changing it.`)
      }
    }
    process.exit(0)
  }

  // Codex does not write files through a file_path tool: it emits an
  // apply_patch script whose target is named on `*** Update File:` /
  // `*** Add File:` / `*** Delete File:` lines. Measured 2026-08-15 -- a guard
  // that only policed write/edit let Codex rewrite a frozen test unopposed,
  // because apply_patch never matched. The whole patch text is searched, so a
  // multi-file patch that touches one frozen path is refused entirely.
  case 'apply_patch': {
    const patch = arg('command')
    if (!patch) process.exit(0)
    for (const f of frozen) {
      const b = basename(f)
      const re = new RegExp(`^\\*\\*\\* (Update|Add|Delete) File: (.*/)?${escapeRe(b)}$`, 'm')
      if (re.test(patch)) {
        die(`BLOCKED: this patch modifies ${b}, a frozen test file. Read it; do not edit it. If the test looks wrong, stop and explain instead of changing it.`)
      }
    }
    process.exit(0)
  }

  // `pwsh` is dsh's shell tool on WINDOWS; `bash` is the same tool elsewhere.
  // Handling a name here does nothing unless gen-hooks also puts it in the
  // PreToolUse matcher -- an unmatched tool never reaches this switch at all.
  // Measured 2026-08-20: `pwsh` was handled here and absent there, so every
  // Windows shell call bypassed the allowlist while the config and the canary
  // both looked right. hooks-matcher.test.mjs now enforces the agreement.
  case 'bash': case 'Bash': case 'pwsh': {
    if (!allowCmd) process.exit(0)
    const cmd = arg('command')
    // A prefix match ALONE is an allowlist escape: `<allowed> && curl evil`,
    // `<allowed>; rm -rf /` and `<allowed> | sh` all start with the allowed
    // prefix. Observed on a live run: `... pytest tests/ -q 2>&1 | head -50`
    // was permitted by a prefix-only check. If the whitelist means "exactly one
    // command", then any shell control operator means this is not that command.
    if (/[;&|`><\n]/.test(cmd) || cmd.includes('$(')) {
      die(`BLOCKED: shell control operators are not permitted; only the bare command '${allowCmd}'. Got: ${cmd}`)
    }
    // Strip leading `VAR=value ` assignments before matching. Measured
    // 2026-08-15: the sandbox forces `UV_CACHE_DIR=... uv run ...` (uv cannot
    // write ~/.cache/uv under workspace-write), and a bare prefix match
    // rejected the very form the sandbox required -- the guard blocking its own
    // sandbox's workaround.
    const probe = stripLeadingAssignments(cmd)
    if (probe.startsWith(allowCmdCore)) process.exit(0)
    die(`BLOCKED: only '${allowCmd}' is permitted (leading VAR=value assignments are allowed). Got: ${cmd}`)
  }
}
process.exit(0)

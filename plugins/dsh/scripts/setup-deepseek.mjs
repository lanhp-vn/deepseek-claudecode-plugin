#!/usr/bin/env node
// setup-deepseek.mjs: wire a DeepSeek API key into this machine, then prove it
// works, and scaffold the one per-machine file the seam needs.
//
//   setup-deepseek.mjs                    # find a key, install, verify
//   setup-deepseek.mjs --key sk-...       # take the key from the argument
//   setup-deepseek.mjs --from <file>      # take the key from a file
//   setup-deepseek.mjs --verify-only      # check the installed key, change nothing
//   setup-deepseek.mjs --dsh              # ALSO install it for the dsh backend
//
// THE KEY IS NEVER PRINTED. Every message shows a masked fingerprint.
//
// WHY fetch AND NOT curl. The bash original needed curl and coreutils and so
// needed Git Bash on Windows. Node 24 has global fetch, so this runs natively
// on the platform the whole port exists for. Same for the JSON: no jq.
//
// Exit codes: 0 ok | 1 usage/no key found | 2 key rejected by the API | 3 no key installed
//             4 existing $DSH_HOME/.credentials.yaml is not the flat mapping dsh requires
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join, dirname } from 'node:path'

// Exported so dsh-doctor.mjs checks the same endpoint this installs against.
export const BASE_URL = 'https://api.deepseek.com'

const red = (s) => `\x1b[31m${s}\x1b[0m`
const green = (s) => `\x1b[32m${s}\x1b[0m`
const ok = (s) => console.log(`${green('  ok')}   ${s}`)
const info = (s) => console.log(`       ${s}`)
const die = (msg, code = 1) => { console.error(`${red('error:')} ${msg}`); process.exit(code) }

/** sk-abcd...wxyz, so logs and screenshots stay safe to share. */
export const mask = (k) => (k.length >= 12 ? `${k.slice(0, 7)}...${k.slice(-4)}` : `<short:${k.length}>`)

// Every ${machine.*} key a shipped example can reference, commented out and
// empty. Scaffolding a file full of GUESSED paths would be worse than none: the
// seam refuses a missing key by name, which is a clear error, whereas a wrong
// path mounts a language server that silently does nothing.
const MACHINE_TEMPLATE = `# machine.yml -- values specific to THIS machine.
#
# Referenced from a repository's committed .deepseek/overlay.yml as
# \${machine.<key>}. That indirection is what lets an overlay be committed at
# all: the repo says "use the python for this project", this file says where it
# is here.
#
# NEVER COMMIT THIS FILE. It is per-machine by definition.
#
# A key referenced by an overlay but missing here is a HARD failure naming the
# key, before anything is spent. Uncomment and fill in only what your repos
# actually reference.

# The interpreter a Python language server should resolve imports against.
# python:

# Absolute path to the gitnexus binary, if a repo's overlay mounts it.
# gitnexus_bin:

# The Node/TypeScript language server binary, if not on PATH.
# typescript_language_server:
`

/**
 * Write ~/.deepseek/machine.yml if it is not already there.
 * NEVER clobbers: this file is hand-edited, and re-running setup must not
 * discard what the operator put in it.
 */
export function scaffoldMachine (home) {
  const dir = join(home, '.deepseek')
  const f = join(dir, 'machine.yml')
  if (existsSync(f)) return { path: f, created: false }
  mkdirSync(dir, { recursive: true })
  writeFileSync(f, MACHINE_TEMPLATE)
  try { chmodSync(dir, 0o700) } catch { /* no-op on Windows */ }
  return { path: f, created: true }
}

// WITHOUT THESE TWO, EVERY DELEGATION DIES AT BOOT. The wrapper's patch.yml
// inserts a `hooks-cc` row naming @deepseek-ai/dsh-hooks-claude-code -- that
// row is what mounts the guard at all -- and dsh refuses to start when the
// package is not in the profile ("Cannot find package", exit 1 in about a
// second). dsh-hook-protocol is its peerDependency, which pnpm does NOT install
// on its own. pnpm's "unmet peer" warning is routine noise in this tree and must
// not be read as a health signal -- it was present throughout the five weeks the
// bridge sat a whole release line behind the CLI (see checkProfileLockstep).
//
// A bare `npm i -g @deepseek-ai/dsh` ships NEITHER. This is the single most
// likely reason a fresh install fails, so the doctor names it.
export const HOOK_BRIDGE = Object.freeze([
  '@deepseek-ai/dsh-hooks-claude-code',
  '@deepseek-ai/dsh-hook-protocol',
])

export const HOOK_BRIDGE_FIX =
  `dsh plugin --profile headless add ${HOOK_BRIDGE.join(' ')}`

/**
 * Is the hook bridge present in the headless profile? Returns the missing
 * packages rather than a bare boolean, so the caller can name them.
 */
export function checkHookBridge (dshHome) {
  const pkg = join(dshHome, 'profiles', 'headless', 'package.json')
  if (!existsSync(pkg)) return { ok: false, missing: [...HOOK_BRIDGE], reason: 'no headless profile yet' }
  let deps = {}
  try { deps = JSON.parse(readFileSync(pkg, 'utf8')).dependencies ?? {} } catch {
    return { ok: false, missing: [...HOOK_BRIDGE], reason: `could not read ${pkg}` }
  }
  const missing = HOOK_BRIDGE.filter((r) => !(r in deps))
  return { ok: missing.length === 0, missing, reason: missing.length ? 'missing from the headless profile' : '' }
}

/** The release line of a version string -- "0.1.5-rc.2" -> "0.1.5". */
const releaseLine = (v) => (String(v ?? '').trim().match(/^v?(\d+\.\d+\.\d+)/) ?? [])[1] ?? ''

/**
 * Is the hook bridge on the same release line as the CLI driving it?
 *
 * The bridge reaches into harness internals and its peerDependencies name the
 * CLI's own version family, so a mismatched pair is not a style issue: measured
 * 2026-09-10, a 0.0.1 bridge against a 0.1.x CLI made every tool call fail with
 * `agent.session.events is not iterable` and stopped the PreToolUse hook from
 * firing at all -- a guard that is mounted, passes its canary, and never runs.
 *
 * Nothing upstream enforces the pairing, and npm cannot hint at it either: these
 * packages publish a 0.1.x line while their `latest` tag still points at
 * 0.0.1-rc.*, so an unversioned `dsh plugin ... add` installs the old line
 * against any CLI. That is why this compares rather than trusts.
 *
 * Compares major.minor.patch and not the full pre-release tag: a mismatched
 * LINE is the failure actually measured, and patch drift within a line has not
 * been observed to break anything. Returns ok when it cannot compare -- a
 * missing bridge is checkHookBridge's message to deliver, not this one's.
 */
export function checkProfileLockstep (dshHome, cliVersion) {
  const cli = releaseLine(cliVersion)
  if (!cli) return { ok: true, reason: '' }
  const pkg = join(dshHome, 'profiles', 'headless', 'package.json')
  let deps = {}
  try { deps = JSON.parse(readFileSync(pkg, 'utf8')).dependencies ?? {} } catch { return { ok: true, reason: '' } }
  const raw = deps['@deepseek-ai/dsh-hooks-claude-code']
  const bridge = releaseLine(raw)
  if (!bridge) return { ok: true, reason: '' }
  if (bridge === cli) return { ok: true, bridge: raw, cli: cliVersion, reason: '' }
  return {
    ok: false,
    bridge: raw,
    cli: cliVersion,
    reason: `hook bridge is ${raw} but the CLI is ${String(cliVersion).trim()}. `
      + 'They are version-locked: a mismatched pair fails every tool call and can leave the guard '
      + `mounted but never firing. Fix: dsh plugin --profile headless add @deepseek-ai/dsh-hooks-claude-code@${String(cliVersion).trim()} @deepseek-ai/dsh-hook-protocol@${String(cliVersion).trim()} @deepseek-ai/dsh-session-projection@${String(cliVersion).trim()}`,
  }
}

/**
 * Merge one key into a dsh credentials document, which must stay the FLAT
 * mapping the dsh backend requires (verified against
 * packages/credentials/credentials-local, 2026-08-15). A newer dsh CLI can
 * silently migrate the file to a nested `version`/`refs` shape -- measured
 * 2026-09-04 against dsh 0.1.2-rc.1 -- and an older CLI then fails to boot
 * from it. Rejecting that shape outright, rather than keeping "every line
 * that isn't this key" the way a flat merge would, matters because the
 * nested key's indentation means it would never match that filter: the old
 * code would have kept the whole broken nested block AND appended a new
 * top-level line, reporting success while leaving the file just as broken.
 * @returns {{ok: true, text: string, hasOthers: boolean} | {ok: false, line: string}}
 */
export function mergeFlatCredential (existingText, refKey, value) {
  const lines = existingText === undefined ? [] : existingText.split('\n')
  const others = []
  for (const line of lines) {
    if (!line.trim()) continue
    const m = /^([A-Za-z_][\w.-]*):[ \t]*(\S.*)$/.exec(line)
    if (!m) return { ok: false, line: line.trim() }
    if (m[1] !== refKey) others.push(line)
  }
  return { ok: true, text: [...others, `${refKey}: ${value}`].join('\n') + '\n', hasOthers: others.length > 0 }
}

/** Write a file only the owner can read, without a world-readable window. */
function writePrivate (path, content) {
  mkdirSync(dirname(path), { recursive: true })
  // mode on open, not chmod after: redirecting first and chmod-ing after leaves
  // the key group/world-readable in between, and Ubuntu's default umask (002)
  // makes that window real rather than theoretical.
  writeFileSync(path, content, { mode: 0o600 })
  try { chmodSync(path, 0o600) } catch { /* no-op on Windows */ }
}

function parseArgv (argv) {
  const o = { key: '', from: '', verifyOnly: false, dsh: false }
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--key': o.key = argv[++i] ?? ''; o.src = '--key argument'; break
      case '--from': o.from = argv[++i] ?? ''; break
      case '--verify-only': o.verifyOnly = true; break
      case '--dsh': o.dsh = true; break
      case '-h': case '--help': o.help = true; break
      default: die(`unknown argument: ${argv[i]}`)
    }
  }
  return o
}

/** First hit wins, most-explicit to most-ambient. */
export function findKey (o, env, home) {
  if (o.key) return { key: o.key, src: '--key argument' }
  if (o.from) {
    if (!existsSync(o.from)) die(`--from file not found: ${o.from}`)
    return { key: readFileSync(o.from, 'utf8').trim(), src: o.from }
  }
  if (env.DEEPSEEK_API_KEY) return { key: env.DEEPSEEK_API_KEY, src: '$DEEPSEEK_API_KEY' }
  const f = join(home, '.deepseek', 'api-key')
  if (existsSync(f)) return { key: readFileSync(f, 'utf8').trim(), src: `${f} (already installed)` }
  return { key: '', src: '' }
}

async function main (argv) {
  const o = parseArgv(argv)
  if (o.help) { console.log(MACHINE_TEMPLATE.split('\n')[0]); return 0 }
  const home = homedir()

  info(`node ${process.version}  platform ${platform()}`)
  // dsh runs command hooks through ctx.shell. On Windows that is PowerShell,
  // which cannot execute a .sh -- the reason the guard is .mjs and the hook
  // command names the interpreter.
  info(`dsh will run hooks through ${platform() === 'win32' ? 'PowerShell' : 'sh'}`)

  // Check the hook bridge BEFORE touching the key: a missing bridge makes every
  // delegation fail no matter how good the credentials are.
  const dshHome = process.env.DSH_HOME ?? join(home, '.dsh')
  const bridge = checkHookBridge(dshHome)
  if (bridge.ok) ok('hook bridge present in the headless profile (the guard can mount)')
  else {
    console.error(`${red('  MISSING')} the guard cannot mount: ${bridge.missing.join(', ')} (${bridge.reason})`)
    console.error(`          every delegation would fail at boot. Fix with:`)
    console.error(`            ${HOOK_BRIDGE_FIX}`)
  }

  const { key, src } = findKey(o, process.env, home)
  if (!key) die('no key found. Pass --key sk-... or --from <file>, or set $DEEPSEEK_API_KEY', 3)
  if (!key.startsWith('sk-')) die(`that does not look like a DeepSeek key (expected an sk- prefix, got ${mask(key)})`)
  info(`key ${mask(key)} from ${src}`)

  // /models costs nothing and proves the key is accepted, so it runs before any
  // billable call. A bad key must fail here, not halfway through a delegation.
  let res
  try {
    res = await fetch(`${BASE_URL}/models`, { headers: { Authorization: `Bearer ${key}` } })
  } catch (e) {
    die(`could not reach ${BASE_URL} - check network/proxy (${e.message})`, 2)
  }
  if (res.status === 401) die('key rejected (HTTP 401). Check it at https://platform.deepseek.com/api_keys', 2)
  if (res.status === 402) die('insufficient balance (HTTP 402). Top up at https://platform.deepseek.com', 2)
  if (res.status === 200) {
    ok(`key accepted by ${BASE_URL}/models`)
    try {
      const ids = (await res.json()).data?.map((m) => m.id).filter(Boolean) ?? []
      if (ids.length) info(`models: ${ids.join(', ')}`)
    } catch { /* informational only */ }
  } else {
    info(`unexpected HTTP ${res.status} from /models; continuing`)
  }

  // Balance is informational: pay-as-you-go with no free tier, so a zero
  // balance fails every later call with a 402 that is easy to misread as a
  // broken brief.
  try {
    const b = await (await fetch(`${BASE_URL}/user/balance`, { headers: { Authorization: `Bearer ${key}` } })).json()
    const infos = b.balance_infos ?? []
    if (infos.length) info(`balance: ${infos.map((i) => `${i.total_balance} ${i.currency}`).join(', ')}`)
  } catch { /* informational only */ }

  if (o.verifyOnly) { ok('verify-only: nothing written'); return 0 }

  writePrivate(join(home, '.deepseek', 'api-key'), `${key}\n`)
  try { chmodSync(join(home, '.deepseek'), 0o700) } catch { /* no-op on Windows */ }
  ok(`wrote ${join(home, '.deepseek', 'api-key')} (mode 600)`)

  const m = scaffoldMachine(home)
  ok(m.created ? `scaffolded ${m.path}` : `${m.path} already exists, left alone`)

  // The dsh backend reads $DSH_HOME/.credentials.yaml, a FLAT mapping and
  // nothing else -- a nested shape is rejected outright (verified against
  // packages/credentials/credentials-local, 2026-08-15).
  //
  // Stated honestly: this keeps the key out of process.env, so it is not handed
  // to every subprocess the delegate spawns and does not show in an `env` dump.
  // It is NOT a boundary. The provider's own README says the 0600 file "stops
  // other OS users, not the model": tool processes run as the same user and
  // workspace-write confines mutations rather than reads. A deliberate `cat`
  // still reaches it.
  if (o.dsh) {
    const cred = join(dshHome, '.credentials.yaml')
    const existing = existsSync(cred) ? readFileSync(cred, 'utf8') : undefined
    const merged = mergeFlatCredential(existing, 'DEEPSEEK_API_KEY', key)
    if (!merged.ok) {
      die(`${cred} is not the flat mapping the dsh backend requires (found "${merged.line}").\n` +
        `       A newer dsh CLI can migrate this file to a nested version/refs shape that an older\n` +
        `       CLI then fails to boot from -- see CLAUDE.md's platform hazards. Replace it with a\n` +
        `       flat mapping (e.g. "DEEPSEEK_API_KEY: sk-...") and re-run --dsh.`, 4)
    }
    if (merged.hasOthers) info(`note: ${cred} holds other entries; rewriting only the DEEPSEEK_API_KEY line`)
    writePrivate(cred, merged.text)
    try { chmodSync(dshHome, 0o700) } catch { /* no-op on Windows */ }
    ok(`wrote ${cred} (mode 600) for the dsh backend`)
  }

  console.log(`
Next: the key resolves in this order, so nothing else is needed -
  1. $DEEPSEEK_API_KEY   2. ~/.deepseek/api-key            (claude-code backend)
  3. $DSH_HOME/.credentials.yaml                            (dsh backend)

For the dsh backend the INHERITED ENVIRONMENT ALWAYS WINS over the credentials
file, so the wrapper runs the delegate under a cleared DEEPSEEK_API_KEY.
Exporting the variable in your shell would silently bypass the managed store.`)
  ok('setup complete')
  return 0
}

if (import.meta.filename === process.argv[1]) process.exit(await main(process.argv.slice(2)))

#!/usr/bin/env node
// vendor-delegation.mjs: keep this plugin's `_delegation` in step with the
// operator's dotfiles, and prove it is still in step.
//
// The two halves have DIFFERENT relationships to their source, so they are
// checked differently:
//
//   prose    README.md, references/*.md      verbatim copy   -> SHA-256 manifest
//   scripts  guard, gen-hooks, session-report Node PORT      -> differential test
//
// A hash cannot compare a bash original to a Node port, so the scripts are
// checked BEHAVIOURALLY instead. That is stricter than a hash, not weaker: two
// files can differ in whitespace and agree on every decision, or match in shape
// and disagree on one shell operator. Only the differential answers the
// question that matters -- do they decide the same way?
//
// Usage:
//   UBUNTU_SETUP=~/Documents/system-settings node scripts/vendor-delegation.mjs
//   UBUNTU_SETUP=... BASH_GUARD=... node scripts/vendor-delegation.mjs --check
//
// Exit codes: 0 ok | 1 drift | 2 usage
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..')
const dest = join(repo, 'plugins', 'dsh', 'skills', '_delegation')
const manifestPath = join(repo, 'VENDOR-MANIFEST.json')

// VERBATIM prose only.
//
// README.md is deliberately NOT here. Upstream's copy documents
// `scripts/delegation-guard.sh`; this plugin's guard is `.mjs`, and a verbatim
// copy would tell a reader the boundary is a shell script -- which is exactly
// the thing that silently fails open on Windows. The plugin's _delegation
// README is therefore plugin-authored, not vendored, and says so.
//
// The three references ARE shared discipline and must not fork: routing,
// briefing and the verification gate mean the same thing for agy, codex and
// deepseek, and three copies of a rule drift invisibly.
const PROSE = [
  'references/routing.md',
  'references/briefing.md',
  'references/verification.md',
]

const check = process.argv.includes('--check')
// Hash LF-NORMALISED content. Upstream is LF; a Windows clone with
// core.autocrlf -- the default there -- checks the vendored copy out as CRLF, so
// hashing raw bytes reported DRIFT on all three prose files while nothing had
// been edited (measured 2026-08-20). A verbatim copy is verbatim in CONTENT, and
// a manifest that means different things on different machines is worse than no
// manifest: it fails loudly and wrongly, which teaches the operator to ignore it.
const sha = (s) => `sha256:${createHash('sha256')
  .update(s.split('\r\n').join('\n'), 'utf8').digest('hex')}`

// The provenance header required by conventions/04-skills-and-agents.md. It is
// prepended on vendoring and stripped before hashing, so the hash describes the
// upstream CONTENT and does not change when the commit line does.
const MARK_START = '<!-- VENDORED -- do not edit here'
const MARK_END = '-->'

function stripHeader (text) {
  if (!text.startsWith(MARK_START)) return text
  const i = text.indexOf(MARK_END)
  // `[\r\n]+`, not `\n+`: on a CRLF checkout the text after the header starts
  // with `\r`, so a newline-only class stripped nothing and left two blank lines
  // glued to the front of the body. sha() normalises the separators INSIDE the
  // body; only the leading run has to be dealt with here.
  return i === -1 ? text : text.slice(i + MARK_END.length).replace(/^[\r\n]+/, '')
}

function header (srcRepo, srcPath, commit, date) {
  return `${MARK_START}
  upstream repo:   ${srcRepo}
  upstream path:   skills/_delegation/${srcPath}
  upstream commit: ${commit}
  vendored:        ${date}

  This file is a VERBATIM copy. Edit it upstream and re-run
  scripts/vendor-delegation.mjs; edits made here are drift, and
  vendor-delegation.mjs --check will fail.

  The scripts under scripts/ are NOT verbatim -- they are Node ports of bash
  originals, checked behaviourally by differential.test.mjs rather than by
  hash. README.md here is plugin-authored for the same reason.
${MARK_END}

`
}

function die (msg, code = 2) { console.error(`vendor-delegation: ${msg}`); process.exit(code) }

const upstream = process.env.UBUNTU_SETUP
if (!upstream) die('set UBUNTU_SETUP to the system-settings checkout')
const src = join(upstream, 'skills', '_delegation')
if (!existsSync(src)) die(`no _delegation at ${src}`)

const commit = spawnSync('git', ['-C', upstream, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' })
  .stdout?.trim() || 'unknown'

// ---------------------------------------------------------------------------
// --check: hashes for the prose, the differential for the scripts.
// ---------------------------------------------------------------------------
if (check) {
  if (!existsSync(manifestPath)) die('no VENDOR-MANIFEST.json; run without --check first', 1)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  let drift = 0

  for (const rel of PROSE) {
    const f = join(dest, rel)
    if (!existsSync(f)) { console.error(`DRIFT: ${rel} is missing from the plugin`); drift++; continue }
    const got = sha(stripHeader(readFileSync(f, 'utf8')))
    const want = manifest.prose?.[rel]
    if (!want) { console.error(`DRIFT: ${rel} is not in the manifest`); drift++; continue }
    if (got !== want) { console.error(`DRIFT: ${rel} was edited in the plugin (edit it upstream instead)`); drift++ }
  }

  // Also compare against upstream, so an upstream edit is surfaced too.
  for (const rel of PROSE) {
    const u = join(src, rel)
    if (!existsSync(u)) { console.error(`DRIFT: ${rel} no longer exists upstream`); drift++; continue }
    if (sha(readFileSync(u, 'utf8')) !== manifest.prose?.[rel]) {
      console.error(`DRIFT: ${rel} changed upstream; re-run vendor-delegation.mjs`)
      drift++
    }
  }

  if (drift) { console.error(`\n${drift} prose file(s) drifted.`); process.exit(1) }
  console.log(`prose: ${PROSE.length} files match the manifest and upstream`)

  // The scripts are ports, so ask the only question a hash cannot: do the bash
  // original and the Node port decide every payload the same way?
  const diffTest = join(dest, 'scripts', 'differential.test.mjs')
  const bashGuard = process.env.BASH_GUARD ?? join(src, 'scripts', 'delegation-guard.sh')
  const r = spawnSync(process.execPath, ['--test', diffTest], {
    encoding: 'utf8',
    env: { ...process.env, BASH_GUARD: bashGuard, NODE_GUARD: join(dest, 'scripts', 'delegation-guard.mjs') },
  })
  const out = `${r.stdout}${r.stderr}`
  if (r.status !== 0) {
    console.error(out.split('\n').filter((l) => l.startsWith('✖') || l.includes('divergence')).join('\n'))
    console.error('scripts: the Node port and the bash original DISAGREE. That is a real finding --')
    console.error('work out which is right before changing either. The bash one is only the incumbent.')
    process.exit(1)
  }
  const passed = out.match(/^# pass (\d+)/m)?.[1] ?? out.match(/pass (\d+)/)?.[1] ?? '?'
  console.log(`scripts: bash and Node agree on all ${passed} differential payloads`)
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Vendor.
// ---------------------------------------------------------------------------
const date = new Date().toISOString().slice(0, 10)
const srcRepo = spawnSync('git', ['-C', upstream, 'remote', 'get-url', 'origin'], { encoding: 'utf8' })
  .stdout?.trim() || upstream
const manifest = { vendoredFrom: srcRepo, upstreamCommit: commit, vendoredOn: date, prose: {} }

for (const rel of PROSE) {
  const u = join(src, rel)
  if (!existsSync(u)) die(`upstream is missing ${rel}`)
  const body = readFileSync(u, 'utf8')
  manifest.prose[rel] = sha(body)
  const out = join(dest, rel)
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, header(srcRepo, rel, commit, date) + body)
  console.log(`vendored ${rel}`)
}

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`\nwrote ${manifestPath} (upstream ${commit})`)
console.log('scripts/ are NOT vendored by hash -- they are ports, checked by differential.test.mjs')

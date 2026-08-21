// approval.mjs: capability never arrives silently with a git clone.
//
// `.deepseek/overlay.yml` is a committed file that decides what a delegate may
// USE -- language servers, MCP clients, a PTY. Cloning a repository and running
// a delegation in it would otherwise grant all of that on the operator's
// machine without anyone deciding to. So the first time a given overlay is seen
// at a given path, the run REFUSES and prints what the file would mount.
//
// Three details that are the whole design:
//
//   * The hash is over the RAW FILE BYTES, before ${machine.*} substitution.
//     Hashing after substitution would make it machine-dependent and re-arm the
//     gate on every machine for no reason.
//   * The key is the ABSOLUTE repo path, not the basename. Two clones of the
//     same project are two decisions -- which matters precisely because the
//     secrets control here is "delegate in a worktree".
//   * Editing the overlay re-arms the gate, because the hash changes. Approval
//     is of a specific file content, not of a repository in general.
//
// STORED SEPARATELY FROM machine.yml. Approvals are machine state written by a
// program; machine.yml is hand-authored config with the operator's comments in
// it. A read-modify-write of the YAML would preserve the keys and silently
// destroy every comment around them, so the two are kept apart.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Where approvals live, given a home directory. */
export const approvalStore = (home) => join(home, '.deepseek', 'approvals.json')

/** sha256 of the raw overlay bytes, before any substitution. */
export function hashOverlay (text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
}

function readStore (storePath) {
  if (!existsSync(storePath)) return { approved_overlays: {} }
  try {
    const j = JSON.parse(readFileSync(storePath, 'utf8'))
    return { approved_overlays: j.approved_overlays ?? {} }
  } catch {
    // A corrupt store must not read as "everything is approved".
    return { approved_overlays: {} }
  }
}

export function isApproved (storePath, repoRoot, hash) {
  return readStore(storePath).approved_overlays[repoRoot] === hash
}

export function recordApproval (storePath, repoRoot, hash) {
  const store = readStore(storePath)
  store.approved_overlays[repoRoot] = hash
  mkdirSync(dirname(storePath), { recursive: true })
  writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`)
}

/**
 * A human-readable preview of what an overlay would mount.
 *
 * ADVISORY, NOT AUTHORITATIVE. The hash is the security control; this is a
 * reading aid, and the refusal message tells the operator to read the file
 * itself. It scans for the `id:`/`name:` pairs a dsh `insert` row carries
 * rather than parsing the full patch grammar, so it never claims completeness.
 */
export function summarise (overlayText) {
  const lines = []
  let id = null
  for (const raw of String(overlayText ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    const mId = line.match(/^-?\s*id:\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/)
    if (mId) {
      if (id) lines.push(`+ ${id}`)
      id = mId[1].trim()
      continue
    }
    const mName = line.match(/^name:\s*['"]?([^'"#]+?)['"]?\s*(?:#.*)?$/)
    if (mName && id) {
      lines.push(`+ ${id} (${mName[1].trim()})`)
      id = null
    }
  }
  if (id) lines.push(`+ ${id}`)

  // Name every machine value the file would pull in: those are paths on THIS
  // machine, and an operator approving a mount should see them.
  const keys = [...new Set([...String(overlayText ?? '').matchAll(/\$\{machine\.([A-Za-z0-9_.-]+)\}/g)].map((m) => m[1]))]
  for (const k of keys) lines.push(`  uses \${machine.${k}} from ~/.deepseek/machine.yml`)
  return lines
}

/** The refusal text. Printed to stderr; the run exits 2 having spent nothing. */
export function refusalMessage ({ overlayPath, overlayText, repoRoot }) {
  const body = summarise(overlayText).map((l) => `    ${l}`).join('\n')
  return [
    `REFUSED: ${overlayPath} is not approved on this machine.`,
    '',
    '  It would mount:',
    body || '    (no insert rows found -- read the file)',
    '',
    `  Review the file, then approve it:`,
    `    deepseek-run --approve-overlay -C ${repoRoot}`,
    '',
    '  Nothing has been spent.',
  ].join('\n')
}

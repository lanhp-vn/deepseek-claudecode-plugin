// seam.mjs: where a repository declares what its delegations may do.
//
// This replaces the hardcoded `case "$repo_name"` table that used to live in
// the wrapper (deepseek-run.sh:147-207). That table keyed capability on the git
// toplevel's BASENAME, in the operator's own dotfiles -- so a teammate cloning
// the plugin got none of it, and a new repository meant editing a shell script
// on one machine. Capability now travels with the repository that needs it:
//
//     <repo>/.deepseek/overlay.yml   what the delegate may USE  (a dsh patch layer)
//     <repo>/.deepseek/policy.yml    what it may NOT do         (deny sets)
//     ~/.deepseek/machine.yml        this machine's paths       (never committed)
//
// The invariant carried over from the table: capability and its compensating
// deny set are declared TOGETHER. An overlay that mounts a code-graph server
// sits beside the policy that stops the delegate mutating the graph.
//
// A machine-specific value -- an interpreter path, a board address -- would
// otherwise force overlay.yml to be per-machine and therefore uncommittable.
// `${machine.key}` placeholders resolve from ~/.deepseek/machine.yml, which is
// the only per-machine file and is never committed.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseFlatYaml } from './yaml-lite.mjs'

export class MissingMachineKey extends Error {}

/**
 * Look for the seam at a repository root. Both files are optional and their
 * absence is NORMAL -- a repo with no .deepseek/ gets the base composition and
 * the permanent floor, which is a working configuration, not a degraded one.
 */
export function discoverSeam (repoRoot) {
  const dir = join(repoRoot, '.deepseek')
  const at = (n) => (existsSync(join(dir, n)) ? join(dir, n) : null)
  return { overlayPath: at('overlay.yml'), policyPath: at('policy.yml') }
}

/** This machine's values. Absent file is {} -- an overlay with no placeholders needs none. */
export function loadMachine (home) {
  const p = join(home, '.deepseek', 'machine.yml')
  if (!existsSync(p)) return {}
  return parseFlatYaml(readFileSync(p, 'utf8'), p)
}

/** A repository's declared deny sets, or null when it declares none. */
export function loadRepoPolicy (policyPath) {
  if (!policyPath) return null
  return parseFlatYaml(readFileSync(policyPath, 'utf8'), policyPath)
}

/**
 * Resolve ${machine.key} placeholders in an overlay.
 *
 * Substitution is TEXTUAL and happens before the YAML ever reaches dsh, so this
 * module never parses an overlay -- it only substitutes into it. That keeps the
 * full expressiveness of a dsh patch layer available to a repository without
 * this file needing to understand any of it.
 *
 * A missing key is a HARD failure naming the key. Substituting an empty string
 * would produce a syntactically valid overlay pointing at nothing, and dsh would
 * mount a server with a blank command -- the house failure mode, where a bad
 * value degrades quietly instead of stopping. Nothing has been spent at the
 * point this throws.
 */
export function substituteMachine (text, machine = {}) {
  const out = String(text).replace(/\$\{machine\.([A-Za-z0-9_.-]+)\}/g, (_, key) => {
    const v = machine[key]
    if (v === undefined || v === null || v === '' || Array.isArray(v)) {
      throw new MissingMachineKey(
        `overlay.yml references \${machine.${key}} but '${key}' is not set in ~/.deepseek/machine.yml. ` +
        `Add it, or run /deepseek-setup to scaffold the file. Nothing has been spent.`)
    }
    return String(v)
  })
  // A malformed placeholder -- ${machine.} or ${machine.$x} -- does not match
  // the pattern above and would otherwise reach dsh as literal text. Refuse it
  // rather than let it through: no placeholder literal ever survives this call.
  if (out.includes('${machine.')) {
    const bad = out.match(/\$\{machine\.[^}]*\}?/)?.[0] ?? '${machine.'
    throw new MissingMachineKey(
      `overlay.yml contains a malformed machine placeholder: ${bad}. ` +
      `The form is \${machine.key} with key characters [A-Za-z0-9_.-]. Nothing has been spent.`)
  }
  return out
}

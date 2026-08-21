// policy.mjs: the permanent deny floor, and the union-only composition rule.
//
// THE TRUST MODEL, IN ONE LINE: a file that arrives with a clone can TIGHTEN
// the sandbox and can never loosen it.
//
// `.deepseek/policy.yml` is committed, which means it is written by whoever can
// push to the repository -- and read by a delegate running on the operator's
// machine with the operator's filesystem. If that file could lift a deny, then
// "clone this repo and delegate in it" would be a way to hand a delegate a
// capability the operator never granted. So repo policy is unioned in, never
// subtracted, and `allowTool` in a repo file is not read at all.
//
// The escape hatch is the operator's `--allow-tool` flag: it lives in a hand
// and in the session log, never in a file.
//
// The floor applies even when a repository declares nothing, which is the
// common case. A repo with no .deepseek/ is not unguarded.

export const FLOOR = Object.freeze({
  // gitnexus graph MUTATION. Harmless when gitnexus is not mounted, free
  // insurance when it is: Claude Code refuses these through permissions.deny,
  // but that is a Claude Code mechanism a dsh delegate never sees, and gitnexus
  // 1.6.9 reads none of its own GITNEXUS_MCP_* controls (zero hits in its dist,
  // verified 2026-08-19). The guard is the only thing enforcing "the graph is
  // read-only for you".
  //
  // cordis_* executes dynamic packages IN THE LIVE RUNTIME -- denied here
  // before anyone discovers dsh-tool-cordis exists and mounts it.
  denyTool: Object.freeze([
    'mcp__gitnexus__rename', 'mcp__gitnexus__cypher', 'mcp__gitnexus__group_sync',
    'cordis_define', 'cordis_run', 'cordis_undefine',
  ]),
  // Reading IS the leak, so these cover read as well as write -- passing any
  // denyPath widens the hook matcher to the read and search tools.
  denyPath: Object.freeze(['.env*', '*.key', '*.pem', 'credentials/**', '**/.ssh/**', '.git/config']),
  // conventions/01-git-and-saving.md forbids history rewriting, and nothing
  // outward-facing happens without the operator. A delegate does none of it.
  denyCmd: Object.freeze(['git push', 'git push --force', 'git reset --hard', 'git clean -fdx']),
})

const uniq = (a) => [...new Set(a)]

// A repository may write `denyCmd: make deploy` instead of a list. Coercing a
// lone scalar to a one-element list only ever ADDS a deny, so it is safe in the
// one direction that matters. yaml-lite returns null for a bare `key:`.
const asList = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [String(v)])

/**
 * FLOOR ∪ repo policy ∪ CLI denies, minus only what the OPERATOR lifted.
 */
export function composePolicy ({ repoPolicy, cliDeny = {}, allowTool = [] } = {}) {
  const r = repoPolicy ?? {}
  // NOTE: r.allowTool is deliberately NOT read. A committed file cannot lift a
  // floor rule; only the operator flag can. Do not "fix" this.
  return {
    denyPath: uniq([...FLOOR.denyPath, ...asList(r.denyPath), ...asList(cliDeny.denyPath)]),
    denyCmd: uniq([...FLOOR.denyCmd, ...asList(r.denyCmd), ...asList(cliDeny.denyCmd)]),
    denyTool: uniq([...FLOOR.denyTool, ...asList(r.denyTool), ...asList(cliDeny.denyTool)])
      .filter((t) => !allowTool.includes(t)),
  }
}

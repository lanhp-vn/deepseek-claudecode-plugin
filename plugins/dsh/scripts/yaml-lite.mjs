// yaml-lite.mjs: a deliberately tiny, deliberately STRICT reader for the two
// flat YAML files this plugin owns -- `~/.deepseek/machine.yml` and a
// repository's `.deepseek/policy.yml`.
//
// WHY NOT THE `yaml` PACKAGE. The whole plugin would otherwise carry one
// runtime dependency for the sake of parsing two flat key/value files. Whether
// Claude Code installs a plugin's node dependencies into its cache is an
// assumption nobody has verified, and a wrapper that dies on a missing
// `node_modules` is a worse outcome than a 90-line reader. The guard already
// holds the line at zero dependencies; this extends it to the whole plugin.
//
// THE ONE PROPERTY THAT MATTERS: this is a strict SUBSET of YAML. Anything it
// accepts, a real YAML parser accepts with the same meaning. It buys that by
// REFUSING everything it does not fully understand, naming the file and line.
// The alternative -- guessing -- is the house failure mode: a bad model name
// falls back, a bad effort value is ignored, an image becomes placeholder text,
// and nothing raises an error. A policy file is the last place to do that.
//
// Supported, and nothing else:
//
//     # a comment
//     key: scalar
//     quoted: "with spaces"
//     listkey:
//       - item
//       - "*.enc"
//
// Refused with a line number: tabs, nested mappings, flow collections
// (`[a, b]`, `{a: b}`), block scalars (`|`, `>`), anchors and aliases,
// directives, duplicate keys, and a list item before any key.
//
// NOTE ON GLOBS. In real YAML a bare `*` starts an ALIAS, so `- *.enc` is a
// parse error, not the string `*.enc`. A reader that quietly accepted it would
// hand back a value the `yaml` package would reject -- the exact divergence
// this file exists to avoid. So an unquoted value starting with a YAML
// indicator character is refused, with a message telling the author to quote
// it. Every glob in a shipped example is quoted for the same reason.

export class YamlLiteError extends Error {}

// The YAML indicator characters that cannot start a plain (unquoted) scalar.
const INDICATORS = new Set(['*', '&', '!', '[', ']', '{', '}', '|', '>', '%', '@', '`', ','])

function scalar (raw, where) {
  const v = raw.trim()
  if (v === '') return ''
  if (v[0] === '"' || v[0] === "'") {
    const q = v[0]
    // Find the real close. In a single-quoted YAML scalar '' is an ESCAPED
    // quote, not the end -- scanning for the first `'` cut `'it''s here'` in
    // half and then complained about trailing text (found 2026-08-20 by the
    // differential against PyYAML).
    let end = -1
    for (let j = 1; j < v.length; j++) {
      if (v[j] !== q) continue
      if (q === "'" && v[j + 1] === "'") { j++; continue }
      if (q === '"' && v[j - 1] === '\\') continue
      end = j
      break
    }
    if (end === -1) throw new YamlLiteError(`${where}: unterminated ${q} quote`)
    const tail = v.slice(end + 1).trim()
    if (tail && tail[0] !== '#') {
      throw new YamlLiteError(`${where}: trailing text after a quoted value: ${tail}`)
    }
    const inner = v.slice(1, end)
    // Single quotes are literal in YAML apart from '' -> '. Double quotes take
    // the small escape set these files could plausibly need.
    return q === "'"
      ? inner.replaceAll("''", "'")
      : inner.replace(/\\(["\\ntr])/g, (_, c) => ({ n: '\n', t: '\t', r: '\r' }[c] ?? c))
  }
  if (INDICATORS.has(v[0])) {
    throw new YamlLiteError(
      `${where}: a plain value cannot start with '${v[0]}' in YAML -- quote it, e.g. "${v}". ` +
      `Globs such as *.enc MUST be quoted or a real YAML parser reads them as an alias.`)
  }
  // A comment needs whitespace before the '#', same as YAML.
  return v.replace(/\s+#.*$/, '').trim()
}

/**
 * Parse a flat YAML document into a plain object. Values are strings, or arrays
 * of strings for block lists. Returns {} for an empty document.
 */
export function parseFlatYaml (text, source = 'yaml') {
  const out = Object.create(null)
  let listKey = null
  const lines = String(text ?? '').split(/\r?\n/)

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const where = `${source}:${i + 1}`
    if (/^\s*$/.test(raw) || /^\s*#/.test(raw)) continue
    if (raw.includes('\t')) throw new YamlLiteError(`${where}: tabs are not valid YAML indentation`)
    if (raw.startsWith('%') || raw.startsWith('---') || raw.startsWith('...')) {
      throw new YamlLiteError(`${where}: document markers and directives are not supported here`)
    }

    const item = raw.match(/^(\s+)-(\s+.*|)$/)
    if (item) {
      if (listKey === null) throw new YamlLiteError(`${where}: a list item before any key`)
      if (out[listKey] === null) out[listKey] = []
      out[listKey].push(scalar(item[2], where))
      continue
    }

    const kv = raw.match(/^([A-Za-z_][A-Za-z0-9_.-]*)\s*:(\s.*|)$/)
    if (!kv) {
      throw new YamlLiteError(
        `${where}: expected 'key: value', 'key:' or a '  - item' list entry, got: ${raw.trim()}`)
    }
    const [, key, rest] = kv
    if (key in out) throw new YamlLiteError(`${where}: duplicate key '${key}'`)
    const value = rest.trim()
    if (value === '' || value[0] === '#') {
      // `key:` opens a block list. With nothing under it the value is NULL, not
      // an empty list -- that is what a real YAML parser returns, and matching
      // it exactly is the whole point of this file (found 2026-08-20 by the
      // differential against PyYAML, which said null where this said []).
      // Callers therefore write `x.denyPath ?? []`.
      out[key] = null
      listKey = key
    } else {
      out[key] = scalar(rest, where)
      listKey = null
    }
  }
  return { ...out }
}

/** Read a flat YAML file, or return {} when it does not exist. */
export function readFlatYaml (path, readFileSync, existsSync) {
  if (!existsSync(path)) return {}
  return parseFlatYaml(readFileSync(path, 'utf8'), path)
}

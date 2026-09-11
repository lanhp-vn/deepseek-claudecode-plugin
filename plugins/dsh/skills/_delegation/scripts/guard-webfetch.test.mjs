import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// A research delegation is the one run that gets a fetch backend, and the
// backend does not refuse private-network targets on its own.
//
// Ordinary runs never reach this rule: the wrapper writes `fetch: false` into
// tool-web so web_fetch is never registered. `--web-fetch` turns it on, and from
// that moment a link in a search result -- or text on a page the delegate just
// read -- can point at a cloud metadata endpoint, a service on localhost, or the
// operator's LAN. The delegate is not the adversary; the page it reads might be.
//
// The alternate IPv4 encodings below are the point of the exercise. A check
// written as `startsWith('127.')` passes every one of them, which is exactly how
// this class of control gets walked past.
const GUARD_SRC = fileURLToPath(new URL('./delegation-guard.mjs', import.meta.url))

function guardDir (webFetch) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-web-'))
  copyFileSync(GUARD_SRC, join(dir, 'delegation-guard.mjs'))
  writeFileSync(join(dir, 'policy.json'), JSON.stringify({
    frozen: [], allowCmd: '', denyPath: [], denyCmd: [], denyTool: [], webFetch,
  }))
  return dir
}
const ON = guardDir(true)
const OFF = guardDir(false)

const decide = (dir, url) => spawnSync(
  process.execPath, [join(dir, 'delegation-guard.mjs')],
  { input: JSON.stringify({ tool_name: 'web_fetch', tool_input: { url } }), encoding: 'utf8' },
).status

const BLOCK = 2
const ALLOW = 0

test('public documentation hosts are allowed', () => {
  for (const u of [
    'https://api-docs.deepseek.com/updates/',
    'https://github.com/deepseek-ai/deepseek-harness/releases',
    'http://example.com/a/b?c=d#e',
    'https://8.8.8.8/',                       // public literal
    'https://registry.npmjs.org/@deepseek-ai/dsh',
  ]) assert.equal(decide(ON, u), ALLOW, `should allow ${u}`)
})

test('loopback is refused however the address is spelled', () => {
  for (const u of [
    'http://127.0.0.1:8080/admin',
    'http://localhost:3000/',
    'http://LOCALHOST/',
    'http://127.1/',                          // short form
    'http://2130706433/',                     // bare decimal
    'http://0177.0.0.1/',                     // octal
    'http://0x7f.0.0.1/',                     // hex
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',             // IPv4-mapped IPv6
    'http://localhost./',                     // trailing-dot FQDN
  ]) assert.equal(decide(ON, u), BLOCK, `should block ${u}`)
})

test('cloud metadata and private ranges are refused', () => {
  for (const u of [
    'http://169.254.169.254/latest/meta-data/',   // the one that matters most
    'http://10.0.0.5/',
    'http://172.16.0.1/',
    'http://172.31.255.254/',
    'http://192.168.1.1/',
    'http://100.64.0.1/',                          // CGNAT
    'http://[fd00::1]/',                           // unique-local
    'http://[fe80::1]/',                           // link-local
    'https://printer.local/',
    'https://wiki.internal/',
  ]) assert.equal(decide(ON, u), BLOCK, `should block ${u}`)
})

test('172.15 and 172.32 are public and stay allowed', () => {
  // The RFC1918 middle block is 172.16-31 only. Blocking all of 172/8 would be
  // a false positive on real public hosts, which is how an over-broad control
  // gets switched off entirely.
  for (const u of ['http://172.15.0.1/', 'http://172.32.0.1/']) {
    assert.equal(decide(ON, u), ALLOW, `should allow ${u}`)
  }
})

test('non-http schemes are refused', () => {
  for (const u of ['file:///etc/passwd', 'ftp://example.com/x', 'gopher://example.com/']) {
    assert.equal(decide(ON, u), BLOCK, `should block ${u}`)
  }
})

test('a missing or unparseable url is refused, not waved through', () => {
  assert.equal(decide(ON, ''), BLOCK)
  assert.equal(decide(ON, 'not a url'), BLOCK)
})

// The rule is inert unless the operator asked for it, so a normal delegation
// pays nothing for it and behaves exactly as it did before the flag existed.
test('with webFetch off the rule does not fire at all', () => {
  assert.equal(decide(OFF, 'http://169.254.169.254/latest/meta-data/'), ALLOW)
})

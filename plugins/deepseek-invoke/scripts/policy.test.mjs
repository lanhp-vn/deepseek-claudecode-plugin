import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FLOOR, composePolicy } from './policy.mjs'

test('the floor always applies, even with no repo policy', () => {
  const p = composePolicy({ repoPolicy: null, cliDeny: {}, allowTool: [] })
  assert.ok(p.denyTool.includes('mcp__gitnexus__cypher'))
  assert.ok(p.denyTool.includes('cordis_run'))
  assert.ok(p.denyPath.includes('.env*'))
  assert.ok(p.denyCmd.some((c) => c.includes('git push')))
})

test('the floor applies when called with no arguments at all', () => {
  assert.ok(composePolicy().denyTool.includes('cordis_run'))
})

test('a repo policy can ADD denies', () => {
  const p = composePolicy({ repoPolicy: { denyCmd: ['make deploy'] }, cliDeny: {}, allowTool: [] })
  assert.ok(p.denyCmd.includes('make deploy'))
  assert.ok(p.denyCmd.some((c) => c.includes('git push')), 'floor survives')
})

// The whole point of the trust model: a committed file cannot loosen anything.
test('a repo policy CANNOT remove a floor rule', () => {
  const p = composePolicy({
    repoPolicy: { denyTool: [], allowTool: ['cordis_run'], denyPath: [] },
    cliDeny: {}, allowTool: [],
  })
  assert.ok(p.denyTool.includes('cordis_run'), 'repo allowTool is ignored entirely')
  assert.ok(p.denyPath.includes('.env*'))
})

// The escape hatch is an operator flag, never a file.
test('an operator --allow-tool CAN remove a floor rule', () => {
  const p = composePolicy({ repoPolicy: null, cliDeny: {}, allowTool: ['cordis_run'] })
  assert.ok(!p.denyTool.includes('cordis_run'))
  assert.ok(p.denyTool.includes('mcp__gitnexus__cypher'), 'only the named rule is lifted')
})

test('--allow-tool does NOT lift a denied path or command', () => {
  const p = composePolicy({ repoPolicy: null, cliDeny: {}, allowTool: ['.env*', 'git push'] })
  assert.ok(p.denyPath.includes('.env*'), 'allow-tool is about tools only')
  assert.ok(p.denyCmd.includes('git push'))
})

test('CLI denies are unioned in too', () => {
  const p = composePolicy({ repoPolicy: null, cliDeny: { denyPath: ['secrets.json'] }, allowTool: [] })
  assert.ok(p.denyPath.includes('secrets.json'))
  assert.ok(p.denyPath.includes('credentials/**'), 'floor survives')
})

test('duplicates collapse', () => {
  const p = composePolicy({ repoPolicy: { denyCmd: ['git push'] }, cliDeny: { denyCmd: ['git push'] } })
  assert.equal(p.denyCmd.filter((c) => c === 'git push').length, 1)
})

// yaml-lite returns null for a bare `denyPath:`; a teammate may also write a
// lone scalar. Neither may throw, and a scalar may only ADD.
test('a null or scalar repo value is handled, never thrown on', () => {
  assert.ok(composePolicy({ repoPolicy: { denyPath: null } }).denyPath.includes('.env*'))
  assert.ok(composePolicy({ repoPolicy: { denyCmd: 'make deploy' } }).denyCmd.includes('make deploy'))
})

test('the floor object is frozen', () => {
  assert.throws(() => { FLOOR.denyTool.push('x') })
  assert.throws(() => { FLOOR.denyPath.push('x') })
  assert.throws(() => { FLOOR.denyCmd.push('x') })
})

test('composing does not mutate the floor', () => {
  const before = [...FLOOR.denyCmd]
  composePolicy({ repoPolicy: { denyCmd: ['make deploy'] } })
  assert.deepEqual([...FLOOR.denyCmd], before)
})

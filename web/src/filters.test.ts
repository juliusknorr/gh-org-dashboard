import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Item } from '../../shared/types.ts'
import { DEFAULT_FILTERS, countBy, filterItems, parseFilters, serializeFilters } from './filters.ts'

const now = Date.parse('2026-10-01T00:00:00Z')
const daysAgo = (n: number) => new Date(now - n * 86_400_000).toISOString()

const item = (over: Partial<Item>): Item => ({
  id: String(Math.random()),
  type: 'issue',
  repo: 'server',
  number: 1,
  title: 'Something',
  url: '',
  state: 'open',
  draft: false,
  author: 'alice',
  authorAssociation: 'MEMBER',
  assignees: [],
  labels: [],
  milestone: null,
  reviewRequests: [],
  reviewDecision: null,
  ci: null,
  comments: 0,
  createdAt: daysAgo(30),
  updatedAt: daysAgo(1),
  closedAt: null,
  ...over,
})

const items = [
  item({ number: 1, title: 'Crash on login', labels: [{ name: 'bug', color: 'd73a4a' }] }),
  item({ number: 2, type: 'pr', state: 'merged', ci: 'SUCCESS', reviewDecision: 'APPROVED' }),
  item({ number: 3, type: 'pr', repo: 'text', draft: true, authorAssociation: 'NONE', author: 'bob', assignees: ['carol'], reviewRequests: ['dave'] }),
  item({ number: 4, updatedAt: daysAgo(100), labels: [{ name: 'bug', color: 'd73a4a' }, { name: 'stale', color: 'eeeeee' }] }),
]

const numbers = (f: Partial<typeof DEFAULT_FILTERS>) =>
  filterItems(items, { ...DEFAULT_FILTERS, ...f }, now).map((i) => i.number)

test('filters', () => {
  assert.deepEqual(numbers({}), [1, 3, 4])
  assert.deepEqual(numbers({ state: [] }), [1, 2, 3, 4])
  assert.deepEqual(numbers({ state: [], type: 'pr' }), [2, 3])
  assert.deepEqual(numbers({ repo: ['text'] }), [3])
  assert.deepEqual(numbers({ assignee: 'none' }), [1, 4])
  assert.deepEqual(numbers({ assignee: 'carol' }), [3])
  assert.deepEqual(numbers({ label: ['bug', 'stale'] }), [4])
  assert.deepEqual(numbers({ reviewer: 'dave' }), [3])
  assert.deepEqual(numbers({ draft: 'no', type: 'pr' }), [])
  assert.deepEqual(numbers({ state: [], ci: 'SUCCESS' }), [2])
  assert.deepEqual(numbers({ state: [], review: 'none', type: 'pr' }), [3])
  assert.deepEqual(numbers({ state: [], review: 'none' }), [3])
  assert.deepEqual(numbers({ state: [], draft: 'no' }), [2])
  assert.deepEqual(numbers({ who: 'community' }), [3])
  assert.deepEqual(numbers({ staleFor: 30 }), [4])
  assert.deepEqual(numbers({ updatedWithin: 7 }), [1, 3])
  assert.deepEqual(numbers({ q: 'LOGIN' }), [1])
  assert.deepEqual(numbers({ q: 'text#3' }), [3])
})

test('url round-trip', () => {
  assert.equal(serializeFilters(DEFAULT_FILTERS), '')
  assert.deepEqual(parseFilters(''), DEFAULT_FILTERS)
  const f = { ...DEFAULT_FILTERS, state: [], repo: ['a', 'b'], label: ['x y'], staleFor: 14, q: 'foo&bar', sort: 'created' }
  assert.deepEqual(parseFilters(serializeFilters(f)), f)
  assert.deepEqual(parseFilters('?state=closed&state=merged&staleFor=abc').state, ['closed', 'merged'])
  assert.equal(parseFilters('?staleFor=abc').staleFor, 0)
})

test('countBy', () => {
  assert.deepEqual(countBy(items, (i) => i.labels.map((l) => l.name)), [['bug', 2], ['stale', 1]])
  assert.deepEqual(countBy(items, (i) => [i.ci]), [['none', 3], ['SUCCESS', 1]])
})

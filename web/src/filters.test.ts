import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Item } from '../../shared/types.ts'
import { authorKind, DEFAULT_FILTERS, countBy, filterItems, parseFilters, serializeFilters } from './filters.ts'

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
  member: true,
  bot: false,
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
  firstReviewAt: null,
  triagedAt: null,
  triagedBy: null,
  ...over,
})

const items = [
  item({ number: 1, title: 'Crash on login', labels: [{ name: 'bug', color: 'd73a4a' }] }),
  item({ number: 2, type: 'pr', state: 'merged', ci: 'SUCCESS', reviewDecision: 'APPROVED', firstReviewAt: daysAgo(3), closedAt: daysAgo(2) }),
  item({ number: 3, type: 'pr', repo: 'text', draft: true, member: false, author: 'bob', assignees: ['carol'], reviewRequests: ['dave'] }),
  item({ number: 4, updatedAt: daysAgo(100), triagedAt: daysAgo(99), triagedBy: 'carol', labels: [{ name: 'bug', color: 'd73a4a' }, { name: 'stale', color: 'eeeeee' }] }),
]

const numbers = (f: Partial<typeof DEFAULT_FILTERS>) =>
  filterItems(items, { ...DEFAULT_FILTERS, ...f }, now).map((i) => i.number)

test('filters', () => {
  assert.deepEqual(numbers({}), [1, 3, 4])
  assert.deepEqual(numbers({ state: [] }), [1, 2, 3, 4])
  assert.deepEqual(numbers({ state: [], type: 'pr' }), [2, 3])
  assert.deepEqual(numbers({ repo: ['text'] }), [3])
  assert.deepEqual(numbers({ org: ['text'] }), [3])
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
  assert.deepEqual(numbers({ item: items[0].id }), [1, 3, 4])
  assert.deepEqual(numbers({ state: [], firstReview: 'yes' }), [2])
  assert.deepEqual(numbers({ state: [], firstReview: 'no' }), [3])
  assert.deepEqual(numbers({ state: [], triaged: 'no' }), [1])
  assert.deepEqual(numbers({ state: [], triaged: 'yes' }), [4])
  assert.deepEqual(numbers({ state: [], triagedBy: 'carol' }), [4])
  assert.deepEqual(numbers({ state: [], triagedBy: 'dave' }), [])
  assert.deepEqual(numbers({ created: `${daysAgo(30).slice(0, 10)}..` }), [1, 3, 4])
  assert.deepEqual(numbers({ created: `..${daysAgo(31).slice(0, 10)}` }), [])
  assert.deepEqual(numbers({ state: [], closed: daysAgo(2).slice(0, 10) }), [2])
})

test('read items only resurface after an update', () => {
  const seen = item({ readAt: daysAgo(1) })
  const updated = item({ readAt: daysAgo(2) })
  const unseen = item({})
  const pick = (read: typeof DEFAULT_FILTERS.read) => filterItems([seen, updated, unseen], { ...DEFAULT_FILTERS, read }, now)
  assert.deepEqual(pick('unread'), [updated, unseen])
  assert.deepEqual(pick('read'), [seen])
  assert.deepEqual(pick(''), [seen, updated, unseen])
  assert.equal(parseFilters(serializeFilters({ ...DEFAULT_FILTERS, read: '' })).read, '')
})

test('url round-trip', () => {
  assert.equal(serializeFilters(DEFAULT_FILTERS), '')
  assert.deepEqual(parseFilters(''), DEFAULT_FILTERS)
  const f = { ...DEFAULT_FILTERS, state: [], repo: ['a', 'b'], label: ['x y'], staleFor: 14, q: 'foo&bar', sort: 'created' }
  assert.deepEqual(parseFilters(serializeFilters(f)), f)
  assert.deepEqual(parseFilters('?state=closed&state=merged&staleFor=abc').state, ['closed', 'merged'])
  assert.equal(parseFilters('?staleFor=abc').staleFor, 0)
  const open = { ...f, item: 'I_kwDO/1' }
  assert.deepEqual(parseFilters(serializeFilters(open)), open)
  assert.equal(parseFilters('?item=abc').item, 'abc')
})

test('countBy', () => {
  assert.deepEqual(countBy(items, (i) => i.labels.map((l) => l.name)), [['bug', 2], ['stale', 1]])
  assert.deepEqual(countBy(items, (i) => [i.ci]), [['none', 3], ['SUCCESS', 1]])
})

test('authorKind separates members, community and bots', () => {
  assert.equal(authorKind(item({})), 'member')
  assert.equal(authorKind(item({ member: false })), 'community')
  assert.equal(authorKind(item({ member: false, bot: true })), 'bot')
})

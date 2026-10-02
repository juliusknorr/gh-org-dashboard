import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Item } from '../../shared/types.ts'
import { DAY, isoDate, overview, quantile, weekStart } from './overview.ts'

const now = Date.parse('2026-10-01T12:00:00Z')
const at = (days: number) => new Date(now - days * DAY).toISOString()

const item = (over: Partial<Item>): Item => ({
  id: String(Math.random()),
  type: 'issue',
  repo: 'server',
  number: 1,
  title: '',
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
  createdAt: at(1),
  updatedAt: at(1),
  closedAt: null,
  firstReviewAt: null,
  triagedAt: null,
  triagedBy: null,
  ...over,
})

test('weekStart is Monday UTC', () => {
  assert.equal(isoDate(weekStart(now)), '2026-09-28')
  assert.equal(isoDate(weekStart(Date.parse('2026-09-28T00:00:00Z'))), '2026-09-28')
  assert.equal(isoDate(weekStart(Date.parse('2026-09-27T23:59:59Z'))), '2026-09-21')
})

test('quantile', () => {
  assert.equal(quantile([], 0.5), null)
  assert.equal(quantile([5, 1, 3], 0.5), 3)
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5)
  assert.equal(quantile([...Array(11).keys()], 0.9), 9)
})

test('overview buckets, review times and new contributors', () => {
  const o = overview(
    [
      item({ author: 'veteran', createdAt: at(400) }),
      item({ author: 'veteran', createdAt: at(2) }),
      item({ author: 'newbie', authorAssociation: 'NONE', type: 'pr', createdAt: at(9), firstReviewAt: at(8) }),
      item({ author: 'newbie', authorAssociation: 'NONE', type: 'pr', createdAt: at(2) }),
      item({ type: 'pr', state: 'merged', createdAt: at(10), closedAt: at(1), firstReviewAt: at(7) }),
      item({ state: 'closed', createdAt: at(100), closedAt: at(100) }),
    ],
    4,
    now,
  )
  assert.equal(o.series.length, 4)
  assert.equal(isoDate(o.from), '2026-09-07')
  assert.deepEqual(
    o.series.map((w) => [w.issuesOpened, w.issuesClosed, w.prsOpened, w.prsClosed]),
    [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 2, 0], [1, 0, 1, 1]],
  )
  assert.equal(o.series[2].reviewMedian, 2 * DAY)
  assert.equal(o.review.median, 2 * DAY)
  assert.equal(o.review.waiting, 1)
  assert.equal(o.totals.communityPrs, 2)
  assert.deepEqual(o.newContributors.map((c) => [c.author, c.count]), [['newbie', 2]])
  assert.equal(o.newContributors[0].first.createdAt, at(9))
})

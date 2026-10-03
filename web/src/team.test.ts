import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Item } from '../../shared/types.ts'
import { filterItems, parseFilters } from './filters.ts'
import { DAY } from './overview.ts'
import { members, summary, team } from './team.ts'

const now = Date.parse('2026-10-01T12:00:00Z')
const at = (days: number) => new Date(now - days * DAY).toISOString()

const item = (over: Partial<Item>): Item => ({
  id: String(Math.random()),
  type: 'pr',
  repo: 'server',
  number: 1,
  title: '',
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
  createdAt: at(1),
  updatedAt: at(1),
  closedAt: null,
  firstReviewAt: null,
  triagedAt: null,
  triagedBy: null,
  ...over,
})

const items = [
  item({ createdAt: at(3), firstReviewAt: at(2) }),
  item({ createdAt: at(10), firstReviewAt: at(7), state: 'merged', closedAt: at(5), repo: 'web' }),
  item({ type: 'issue', state: 'closed', closedAt: at(2), triagedAt: at(1), triagedBy: 'alice' }),
  item({ type: 'issue', author: 'dave', member: false, createdAt: at(5), triagedAt: at(3), triagedBy: 'alice' }),
  item({ type: 'issue', author: 'bot', member: false, bot: true, createdAt: at(5), triagedAt: at(5), triagedBy: null }),
  item({ type: 'issue', author: 'bob', assignees: ['alice'], updatedAt: at(40), createdAt: at(50) }),
  item({ author: 'bob', reviewRequests: ['alice'] }),
  item({ author: 'carol', member: false }),
  item({ createdAt: at(400), updatedAt: at(400) }),
]

test('members are member authors sorted by activity', () => {
  assert.deepEqual(members(items, 12, now).map((m) => [m.login, m.active]), [['alice', 3], ['bob', 2]])
})

test('team metrics', () => {
  const t = team(items, 'alice', 4, now)
  assert.equal(t.openPrs.count, 2)
  assert.equal(t.openIssues.count, 0)
  assert.equal(t.reviewRequests.count, 1)
  assert.equal(t.assigned.count, 1)
  assert.equal(t.stale.count, 1)
  assert.equal(t.merged.count, 1)
  assert.equal(t.issuesClosed.count, 1)
  assert.equal(t.review.median, 2 * DAY)
  assert.equal(t.review.unreviewed.count, 0)
  assert.equal(t.triage.triaged.count, 1)
  assert.equal(t.triage.median, 2 * DAY)
  assert.equal(t.untriaged.count, 1)
  assert.equal(summary(items, 'bob', 4, now).triage.triaged.count, 0)
  assert.equal(t.oldestPrs[0].createdAt, at(400))
  assert.deepEqual(t.series.map((w) => [w.opened.count, w.merged.count]), [[0, 0], [0, 0], [1, 1], [1, 0]])
  assert.deepEqual(t.repos.map((r) => [r.repo, r.count]), [['server', 2], ['web', 1]])
})

test('links reproduce their counts on the Items page', () => {
  const t = team(items, 'alice', 4, now)
  const metrics = [t.openPrs, t.reviewRequests, t.assigned, t.stale, t.merged, t.issuesClosed, t.review.reviewed, t.triage.triaged, t.untriaged, ...t.series.flatMap((w) => [w.opened, w.merged]), ...t.repos]
  for (const m of metrics) assert.equal(filterItems(items, parseFilters(m.href.slice(1)), now).length, m.count, m.href)
})

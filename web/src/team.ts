import type { Item } from '../../shared/types.ts'
import { DEFAULT_FILTERS, countBy, filterItems, isMember, serializeFilters, type Filters } from './filters.ts'
import { WEEK, isoDate, quantile, weekRange, weekStart } from './overview.ts'

export const STALE_DAYS = 30
const TOP = 10

export type Query = Partial<Filters>

export interface Metric {
  count: number
  href: string
  list: Item[]
}

export const itemsHref = (query: Query) => `/?${serializeFilters({ ...DEFAULT_FILTERS, ...query })}`

export function members(items: Item[], weeks: number, now = Date.now()) {
  const logins = new Set(items.filter(isMember).map((i) => i.author).filter((a) => a !== null))
  const since = new Date(now - weeks * WEEK).toISOString()
  const stats = new Map([...logins].map((login) => [login, { login, active: 0, last: '' }]))
  for (const i of items) {
    const s = i.author ? stats.get(i.author) : undefined
    if (!s) continue
    if (i.updatedAt >= since) s.active++
    if (i.updatedAt > s.last) s.last = i.updatedAt
  }
  return [...stats.values()].sort((a, b) => b.active - a.active || b.last.localeCompare(a.last))
}

export function team(items: Item[], login: string, weeks: number, now = Date.now()) {
  const mine = items.filter((i) => i.author === login || i.assignees.includes(login) || i.reviewRequests.includes(login))
  const metric = (query: Query): Metric => {
    const list = filterItems(mine, { ...DEFAULT_FILTERS, ...query }, now)
    return { count: list.length, href: itemsHref(query), list }
  }
  const from = weekStart(now) - (weeks - 1) * WEEK
  const since = `${isoDate(from)}..`
  const author = login
  const prs: Query = { author, type: 'pr', state: [] }

  const reviewed = metric({ ...prs, created: since, firstReview: 'yes' })
  const reviewTimes = reviewed.list.map((i) => Date.parse(i.firstReviewAt!) - Date.parse(i.createdAt))
  const openPrs = metric({ author, type: 'pr' })
  const stale = metric({ assignee: login, staleFor: STALE_DAYS })
  const active: Query = { author, state: [], updatedWithin: weeks * 7 }

  return {
    from,
    openPrs,
    openIssues: metric({ author, type: 'issue' }),
    reviewRequests: metric({ reviewer: login }),
    assigned: metric({ assignee: login }),
    merged: metric({ ...prs, state: ['merged'], closed: since }),
    issuesClosed: metric({ author, type: 'issue', state: ['closed'], closed: since }),
    review: { median: quantile(reviewTimes, 0.5), reviewed, unreviewed: metric({ ...prs, created: since, firstReview: 'no' }) },
    series: Array.from({ length: weeks }, (_, n) => {
      const start = from + n * WEEK
      return {
        start,
        opened: metric({ ...prs, created: weekRange(start) }),
        merged: metric({ ...prs, state: ['merged'], closed: weekRange(start) }),
      }
    }),
    oldestPrs: openPrs.list.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, TOP),
    stale: { ...stale, list: stale.list.toSorted((a, b) => a.updatedAt.localeCompare(b.updatedAt)).slice(0, TOP) },
    repos: countBy(metric(active).list, (i) => [i.repo]).map(([repo, count]) => ({ repo, count, href: itemsHref({ ...active, repo: [repo] }) })),
  }
}

export type Team = ReturnType<typeof team>

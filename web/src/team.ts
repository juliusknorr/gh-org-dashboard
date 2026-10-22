import type { Item } from '../../shared/types.ts'
import { DEFAULT_FILTERS, countBy, filterItems, serializeFilters, type Filters } from './filters.ts'
import { WEEK, isoDate, quantile, weekRange, weekStart } from './overview.ts'

export const STALE_DAYS = 30
const TOP = 10

export type Query = Partial<Filters>

export interface Metric {
  count: number
  href: string
  list: Item[]
}

const BASE: Filters = { ...DEFAULT_FILTERS, read: '' }

export const itemsHref = (query: Query) => `/?${serializeFilters({ ...BASE, ...query })}`

export const GROUPS = { core: 'Core team', org: 'Org members', external: 'External' } as const
export type Group = keyof typeof GROUPS

export function members(items: Item[], weeks: number, now = Date.now(), core: string[] = [], group: Group = 'core') {
  const known = new Map(items.map((i) => [i.author?.toLowerCase(), i.author]))
  const authors = (member: boolean) => items.filter((i) => i.member === member && !i.bot).map((i) => i.author).filter((a) => a !== null)
  const logins = new Set(group === 'external' ? authors(false) : group === 'core' && core.length ? core.map((l) => known.get(l.toLowerCase()) ?? l) : authors(true))
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

const scope = (items: Item[], login: string, now: number, org: string) => {
  const mine = items.filter((i) => i.author === login || i.assignees.includes(login) || i.reviewRequests.includes(login) || i.triagedBy === login)
  return (query: Query): Metric => {
    const scoped = org ? { ...query, org: [org] } : query
    const list = filterItems(mine, { ...BASE, ...scoped }, now)
    return { count: list.length, href: itemsHref(scoped), list }
  }
}

export const rangeStart = (weeks: number, now: number) => weekStart(now) - (weeks - 1) * WEEK
const since = (from: number) => `${isoDate(from)}..`
const median = (list: Item[], key: 'firstReviewAt' | 'triagedAt') => quantile(list.map((i) => Date.parse(i[key]!) - Date.parse(i.createdAt)), 0.5)

export function summary(items: Item[], login: string, weeks: number, now = Date.now(), org = '') {
  const metric = scope(items, login, now, org)
  const created = since(rangeStart(weeks, now))
  const author = login
  const prs: Query = { author, type: 'pr', state: [] }
  const reviewed = metric({ ...prs, created, firstReview: 'yes' })
  const triaged = metric({ type: 'issue', state: [], created, triagedBy: login, who: 'community' })
  return {
    login,
    openPrs: metric({ author, type: 'pr' }),
    openIssues: metric({ author, type: 'issue' }),
    reviewRequests: metric({ reviewer: login }),
    assigned: metric({ assignee: login }),
    merged: metric({ ...prs, state: ['merged'], closed: created }),
    issuesClosed: metric({ author, type: 'issue', state: ['closed'], closed: created }),
    review: { median: median(reviewed.list, 'firstReviewAt'), reviewed, unreviewed: metric({ ...prs, created, firstReview: 'no' }) },
    triage: { median: median(triaged.list, 'triagedAt'), triaged },
    untriaged: metric({ assignee: login, type: 'issue', triaged: 'no' }),
  }
}

export type Summary = ReturnType<typeof summary>

export function team(items: Item[], login: string, weeks: number, now = Date.now(), org = '') {
  const metric = scope(items, login, now, org)
  const from = rangeStart(weeks, now)
  const base = summary(items, login, weeks, now, org)
  const prs: Query = { author: login, type: 'pr', state: [] }
  const stale = metric({ assignee: login, staleFor: STALE_DAYS })
  const active: Query = { author: login, state: [], updatedWithin: weeks * 7 }

  return {
    ...base,
    from,
    series: Array.from({ length: weeks }, (_, n) => {
      const start = from + n * WEEK
      return {
        start,
        opened: metric({ ...prs, created: weekRange(start) }),
        merged: metric({ ...prs, state: ['merged'], closed: weekRange(start) }),
        triaged: metric({ type: 'issue', state: [], triagedBy: login, triagedAt: weekRange(start) }),
      }
    }),
    oldestPrs: base.openPrs.list.toSorted((a, b) => a.createdAt.localeCompare(b.createdAt)).slice(0, TOP),
    stale: { ...stale, list: stale.list.toSorted((a, b) => a.updatedAt.localeCompare(b.updatedAt)).slice(0, TOP) },
    repos: countBy(metric(active).list, (i) => [i.repo]).map(([repo, count]) => ({ repo, count, href: itemsHref({ ...active, repo: [repo] }) })),
  }
}

export type Team = ReturnType<typeof team>

export const reviewsPerWeek = (series: { start: number }[], reviews: { url: string; at: string }[]) =>
  series.map(({ start }) => ({ start, reviewed: { count: new Set(reviews.filter((r) => Date.parse(r.at) >= start && Date.parse(r.at) < start + WEEK).map((r) => r.url)).size } }))

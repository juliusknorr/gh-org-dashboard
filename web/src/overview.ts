import type { Item } from '../../shared/types.ts'
import { isMember } from './filters.ts'

export const DAY = 86_400_000
export const WEEK = 7 * DAY
export const RANGES = [4, 12, 26, 52]
const STALE_DAYS = 30
const TOP = 10

export const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10)

export function weekStart(ms: number): number {
  const d = new Date(ms)
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ((d.getUTCDay() + 6) % 7) * DAY
}

export const weekRange = (start: number) => `${isoDate(start)}..${isoDate(start + 6 * DAY)}`

export function quantile(values: number[], q: number): number | null {
  if (!values.length) return null
  const sorted = values.toSorted((a, b) => a - b)
  const pos = (sorted.length - 1) * q
  const lower = Math.floor(pos)
  return sorted[lower] + (sorted[Math.ceil(pos)] - sorted[lower]) * (pos - lower)
}

export interface Week {
  start: number
  issuesOpened: number
  issuesClosed: number
  prsOpened: number
  prsClosed: number
  reviewMedian: number | null
}

export interface Contributor {
  author: string
  first: Item
  count: number
}

const isWaiting = (i: Item) => i.type === 'pr' && i.state === 'open' && !i.draft && !i.firstReviewAt
const byDate = (key: 'createdAt' | 'updatedAt') => (a: Item, b: Item) => a[key].localeCompare(b[key])

export function overview(items: Item[], weeks: number, now = Date.now()) {
  const from = weekStart(now) - (weeks - 1) * WEEK
  const series: Week[] = Array.from({ length: weeks }, (_, n) => ({
    start: from + n * WEEK,
    issuesOpened: 0,
    issuesClosed: 0,
    prsOpened: 0,
    prsClosed: 0,
    reviewMedian: null,
  }))
  const bucket = (iso: string | null) => (iso ? series[Math.floor((weekStart(Date.parse(iso)) - from) / WEEK)] : undefined)
  const reviewTimes: number[][] = series.map(() => [])
  const open = items.filter((i) => i.state === 'open')
  const repos = new Map<string, { repo: string; issues: number; prs: number }>()
  const firsts = new Map<string, Contributor>()

  for (const i of items) {
    const opened = bucket(i.createdAt)
    if (opened) i.type === 'pr' ? opened.prsOpened++ : opened.issuesOpened++
    const closed = i.state !== 'open' ? bucket(i.closedAt) : undefined
    if (closed) i.type === 'pr' ? closed.prsClosed++ : closed.issuesClosed++
    if (opened && i.firstReviewAt) reviewTimes[series.indexOf(opened)].push(Date.parse(i.firstReviewAt) - Date.parse(i.createdAt))
    if (i.state === 'open') {
      const r = repos.get(i.repo) ?? { repo: i.repo, issues: 0, prs: 0 }
      i.type === 'pr' ? r.prs++ : r.issues++
      repos.set(i.repo, r)
    }
    if (i.author) {
      const c = firsts.get(i.author)
      if (!c) firsts.set(i.author, { author: i.author, first: i, count: 1 })
      else {
        c.count++
        if (i.createdAt < c.first.createdAt) c.first = i
      }
    }
  }
  series.forEach((w, n) => (w.reviewMedian = quantile(reviewTimes[n], 0.5)))
  const allReviewTimes = reviewTimes.flat()
  const fromIso = new Date(from).toISOString()

  return {
    from,
    series,
    totals: {
      openIssues: open.filter((i) => i.type === 'issue').length,
      openPrs: open.filter((i) => i.type === 'pr').length,
      waiting: open.filter(isWaiting).length,
      communityPrs: open.filter((i) => i.type === 'pr' && !isMember(i)).length,
      stale: open.filter((i) => now - Date.parse(i.updatedAt) >= STALE_DAYS * DAY).length,
    },
    review: {
      median: quantile(allReviewTimes, 0.5),
      p90: quantile(allReviewTimes, 0.9),
      reviewed: allReviewTimes.length,
      waiting: open.filter((i) => isWaiting(i) && i.createdAt >= fromIso).length,
    },
    repos: [...repos.values()].sort((a, b) => b.issues + b.prs - (a.issues + a.prs) || a.repo.localeCompare(b.repo)),
    stale: open.toSorted(byDate('updatedAt')).slice(0, TOP),
    unreviewed: open.filter(isWaiting).sort(byDate('createdAt')).slice(0, TOP),
    newContributors: [...firsts.values()].filter((c) => c.first.createdAt >= fromIso).sort((a, b) => b.first.createdAt.localeCompare(a.first.createdAt)),
  }
}

export type Overview = ReturnType<typeof overview>

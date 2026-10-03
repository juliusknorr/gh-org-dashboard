import type { Item } from '../../shared/types.ts'
import { isCommunity } from './filters.ts'

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
  triageMedian: number | null
  openIssues: number
  closedIssues: number
}

export interface TopContributor {
  author: string
  member: boolean
  merged: number
  prs: number
  issues: number
}

const TOP_CONTRIBUTORS = 15

function topContributors(items: Item[], fromIso: string): TopContributor[] {
  const top = new Map<string, TopContributor>()
  for (const i of items) {
    const merged = i.state === 'merged' && (i.closedAt ?? '') >= fromIso
    const opened = i.createdAt >= fromIso
    if (!i.author || i.bot || (!merged && !opened)) continue
    const c = top.get(i.author) ?? { author: i.author, member: i.member, merged: 0, prs: 0, issues: 0 }
    if (merged) c.merged++
    if (opened) i.type === 'pr' ? c.prs++ : c.issues++
    top.set(i.author, c)
  }
  return [...top.values()]
    .sort((a, b) => b.merged - a.merged || b.prs + b.issues - (a.prs + a.issues) || a.author.localeCompare(b.author))
    .slice(0, TOP_CONTRIBUTORS)
}

export interface Contributor {
  author: string
  first: Item
  count: number
}

const isWaiting = (i: Item) => i.type === 'pr' && i.state === 'open' && !i.draft && !i.firstReviewAt
const isUntriaged = (i: Item) => i.type === 'issue' && i.state === 'open' && !i.triagedAt
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
    triageMedian: null,
    openIssues: 0,
    closedIssues: 0,
  }))
  const bucket = (iso: string | null) => (iso ? series[Math.floor((weekStart(Date.parse(iso)) - from) / WEEK)] : undefined)
  const reviewTimes: number[][] = series.map(() => [])
  const triageTimes: number[][] = series.map(() => [])
  const open = items.filter((i) => i.state === 'open')
  const repos = new Map<string, { repo: string; issues: number; prs: number }>()
  const firsts = new Map<string, Contributor>()

  for (const i of items) {
    const opened = bucket(i.createdAt)
    if (opened) i.type === 'pr' ? opened.prsOpened++ : opened.issuesOpened++
    const closed = i.state !== 'open' ? bucket(i.closedAt) : undefined
    if (closed) i.type === 'pr' ? closed.prsClosed++ : closed.issuesClosed++
    if (opened && i.firstReviewAt) reviewTimes[series.indexOf(opened)].push(Date.parse(i.firstReviewAt) - Date.parse(i.createdAt))
    if (opened && i.type === 'issue' && i.triagedAt && isCommunity(i))
      triageTimes[series.indexOf(opened)].push(Date.parse(i.triagedAt) - Date.parse(i.createdAt))
    if (i.state === 'open') {
      const r = repos.get(i.repo) ?? { repo: i.repo, issues: 0, prs: 0 }
      i.type === 'pr' ? r.prs++ : r.issues++
      repos.set(i.repo, r)
    }
    if (i.author && !i.bot) {
      const c = firsts.get(i.author)
      if (!c) firsts.set(i.author, { author: i.author, first: i, count: 1 })
      else {
        c.count++
        if (i.createdAt < c.first.createdAt) c.first = i
      }
    }
  }
  series.forEach((w, n) => {
    w.reviewMedian = quantile(reviewTimes[n], 0.5)
    w.triageMedian = quantile(triageTimes[n], 0.5)
    Object.assign(w, issueCounts(items, Math.min(w.start + WEEK, now)))
  })
  const allReviewTimes = reviewTimes.flat()
  const allTriageTimes = triageTimes.flat()
  const fromIso = new Date(from).toISOString()

  return {
    from,
    series,
    totals: {
      openIssues: open.filter((i) => i.type === 'issue').length,
      openPrs: open.filter((i) => i.type === 'pr').length,
      waiting: open.filter(isWaiting).length,
      communityPrs: open.filter((i) => i.type === 'pr' && isCommunity(i)).length,
      untriaged: open.filter(isUntriaged).length,
      stale: open.filter((i) => now - Date.parse(i.updatedAt) >= STALE_DAYS * DAY).length,
    },
    review: {
      median: quantile(allReviewTimes, 0.5),
      p90: quantile(allReviewTimes, 0.9),
      reviewed: allReviewTimes.length,
      waiting: open.filter((i) => isWaiting(i) && i.createdAt >= fromIso).length,
    },
    triage: {
      median: quantile(allTriageTimes, 0.5),
      p90: quantile(allTriageTimes, 0.9),
      triaged: allTriageTimes.length,
      waiting: open.filter((i) => isUntriaged(i) && i.createdAt >= fromIso).length,
    },
    repos: [...repos.values()].sort((a, b) => b.issues + b.prs - (a.issues + a.prs) || a.repo.localeCompare(b.repo)),
    stale: open.toSorted(byDate('updatedAt')).slice(0, TOP),
    untriaged: open.filter(isUntriaged).sort(byDate('createdAt')).slice(0, TOP),
    unreviewed: open.filter(isWaiting).sort(byDate('createdAt')).slice(0, TOP),
    topContributors: topContributors(items, fromIso),
    newContributors: [...firsts.values()].filter((c) => c.first.createdAt >= fromIso).sort((a, b) => b.first.createdAt.localeCompare(a.first.createdAt)),
  }
}

export function issueCounts(items: Item[], at: number) {
  let openIssues = 0
  let closedIssues = 0
  for (const i of items) {
    if (i.type !== 'issue' || Date.parse(i.createdAt) > at) continue
    const closedAt = i.state !== 'open' && i.closedAt ? Date.parse(i.closedAt) : Infinity
    if (closedAt <= at) closedIssues++
    else openIssues++
  }
  return { openIssues, closedIssues }
}

export type Overview = ReturnType<typeof overview>

import type { Item, ItemState } from '../../shared/types.ts'

export interface Filters {
  read: '' | 'unread' | 'read'
  type: '' | 'issue' | 'pr' | 'advisory'
  state: ItemState[]
  repo: string[]
  author: string
  assignee: string
  label: string[]
  reviewer: string
  draft: '' | 'yes' | 'no'
  review: string
  ci: string
  who: '' | AuthorKind
  updatedWithin: number
  staleFor: number
  created: string
  closed: string
  firstReview: '' | 'yes' | 'no'
  triaged: '' | 'yes' | 'no'
  triagedBy: string
  q: string
  sort: string
  item: string
}

export const NONE = 'none'
const DAY = 86_400_000
const LIST_KEYS = ['state', 'repo', 'label'] as const
const NUMBER_KEYS = ['updatedWithin', 'staleFor'] as const

export const DEFAULT_FILTERS: Filters = {
  read: 'unread',
  type: '',
  state: ['open'],
  repo: [],
  author: '',
  assignee: '',
  label: [],
  reviewer: '',
  draft: '',
  review: '',
  ci: '',
  who: '',
  updatedWithin: 0,
  staleFor: 0,
  created: '',
  closed: '',
  firstReview: '',
  triaged: '',
  triagedBy: '',
  q: '',
  sort: '-updated',
  item: '',
}

export const isUnread = (item: Item) => !item.readAt || item.updatedAt > item.readAt

export type AuthorKind = 'member' | 'community' | 'bot'
export const authorKind = (item: Item): AuthorKind => (item.bot ? 'bot' : item.member ? 'member' : 'community')
export const isCommunity = (item: Item) => authorKind(item) === 'community'

function inRange(iso: string | null, range: string) {
  if (!range) return true
  if (!iso) return false
  const [from, to = from] = range.split('..')
  const day = iso.slice(0, 10)
  return (!from || day >= from) && (!to || day <= to)
}

export function matches(item: Item, f: Filters, now = Date.now()): boolean {
  const age = now - Date.parse(item.updatedAt)
  const q = f.q.trim().toLowerCase()
  const isPr = item.type === 'pr'
  return (
    (!f.read || isUnread(item) === (f.read === 'unread')) &&
    (!f.type || item.type === f.type) &&
    (!f.state.length || f.state.includes(item.state)) &&
    (!f.repo.length || f.repo.includes(item.repo)) &&
    (!f.author || item.author === f.author) &&
    (!f.assignee ||
      (f.assignee === NONE ? item.assignees.length === 0 : item.assignees.includes(f.assignee))) &&
    f.label.every((name) => item.labels.some((l) => l.name === name)) &&
    (!f.reviewer || item.reviewRequests.includes(f.reviewer)) &&
    (!f.draft || (isPr && item.draft === (f.draft === 'yes'))) &&
    (!f.review || (isPr && (item.reviewDecision ?? NONE) === f.review)) &&
    (!f.ci || (isPr && (item.ci ?? NONE) === f.ci)) &&
    (!f.who || authorKind(item) === f.who) &&
    (!f.updatedWithin || age <= f.updatedWithin * DAY) &&
    (!f.staleFor || age >= f.staleFor * DAY) &&
    inRange(item.createdAt, f.created) &&
    inRange(item.closedAt, f.closed) &&
    (!f.firstReview || (isPr && !!item.firstReviewAt === (f.firstReview === 'yes'))) &&
    (!f.triaged || (item.type === 'issue' && !!item.triagedAt === (f.triaged === 'yes'))) &&
    (!f.triagedBy || item.triagedBy === f.triagedBy) &&
    (!q || `${item.title} ${item.repo}#${item.number}`.toLowerCase().includes(q))
  )
}

export const filterItems = (items: Item[], f: Filters, now = Date.now()) =>
  items.filter((item) => matches(item, f, now))

export function parseFilters(search: string): Filters {
  const p = new URLSearchParams(search)
  const f: Filters = { ...DEFAULT_FILTERS }
  for (const key of Object.keys(DEFAULT_FILTERS) as (keyof Filters)[]) {
    if (!p.has(key)) continue
    if ((LIST_KEYS as readonly string[]).includes(key)) {
      Object.assign(f, { [key]: p.getAll(key).filter(Boolean) })
    } else if ((NUMBER_KEYS as readonly string[]).includes(key)) {
      Object.assign(f, { [key]: Math.max(0, Number(p.get(key)) || 0) })
    } else {
      Object.assign(f, { [key]: p.get(key) ?? '' })
    }
  }
  return f
}

export function serializeFilters(f: Filters): string {
  const p = new URLSearchParams()
  for (const key of Object.keys(DEFAULT_FILTERS) as (keyof Filters)[]) {
    const value = f[key]
    const fallback = DEFAULT_FILTERS[key]
    if (Array.isArray(value)) {
      if (value.join() === (fallback as string[]).join()) continue
      if (!value.length) p.append(key, '')
      for (const v of value) p.append(key, v)
    } else if (value !== fallback) {
      p.set(key, String(value))
    }
  }
  return p.toString()
}

export function countBy(items: Item[], values: (item: Item) => (string | null)[]) {
  const counts = new Map<string, number>()
  for (const item of items) {
    for (const v of values(item)) counts.set(v ?? NONE, (counts.get(v ?? NONE) ?? 0) + 1)
  }
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

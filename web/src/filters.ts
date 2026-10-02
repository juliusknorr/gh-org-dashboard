import type { Item, ItemState } from '../../shared/types.ts'

export interface Filters {
  type: '' | 'issue' | 'pr'
  state: ItemState[]
  repo: string[]
  author: string
  assignee: string
  label: string[]
  reviewer: string
  draft: '' | 'yes' | 'no'
  review: string
  ci: string
  who: '' | 'member' | 'community'
  updatedWithin: number
  staleFor: number
  q: string
  sort: string
  item: string
}

export const NONE = 'none'
const DAY = 86_400_000
const MEMBER_ASSOCIATIONS = new Set(['MEMBER', 'OWNER', 'COLLABORATOR'])
const LIST_KEYS = ['state', 'repo', 'label'] as const
const NUMBER_KEYS = ['updatedWithin', 'staleFor'] as const

export const DEFAULT_FILTERS: Filters = {
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
  q: '',
  sort: '-updated',
  item: '',
}

export const isMember = (item: Item) => MEMBER_ASSOCIATIONS.has(item.authorAssociation)

export function matches(item: Item, f: Filters, now = Date.now()): boolean {
  const age = now - Date.parse(item.updatedAt)
  const q = f.q.trim().toLowerCase()
  const isPr = item.type === 'pr'
  return (
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
    (!f.who || isMember(item) === (f.who === 'member')) &&
    (!f.updatedWithin || age <= f.updatedWithin * DAY) &&
    (!f.staleFor || age >= f.staleFor * DAY) &&
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

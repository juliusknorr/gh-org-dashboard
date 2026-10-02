import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import {
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  sortFn_basic,
  tableFeatures,
  useTable,
  type SortingState,
  type Updater,
} from '@tanstack/react-table'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Item, ItemsResponse, SyncStatus } from '../../shared/types.ts'
import {
  DEFAULT_FILTERS,
  NONE,
  countBy,
  filterItems,
  isMember,
  parseFilters,
  serializeFilters,
  type Filters,
} from './filters.ts'

const ROW_HEIGHT = 36
const EMPTY: Item[] = []

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { basic: sortFn_basic },
})
const col = createColumnHelper<typeof features, Item>()

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
]
function timeAgo(iso: string) {
  const seconds = (Date.parse(iso) - Date.now()) / 1000
  const [unit, size] = UNITS.find(([, size]) => Math.abs(seconds) >= size) ?? ['second', 1]
  return relative.format(Math.round(seconds / size), unit)
}
const Time = ({ iso }: { iso: string }) => (
  <time dateTime={iso} title={new Date(iso).toLocaleString()}>
    {timeAgo(iso)}
  </time>
)

function textColor(hex: string) {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
  return r * 0.299 + g * 0.587 + b * 0.114 > 150 ? '#000' : '#fff'
}

const FilterButton = ({ filter, value, children }: { filter: 'author' | 'repo' | 'label'; value: string; children?: ReactNode }) => (
  <button type="button" className="link" data-filter={filter} data-value={value} title={`Filter by ${filter} ${value}`}>
    {children ?? value}
  </button>
)

const columns = col.columns([
  col.accessor((i) => (i.type === 'pr' ? (i.draft ? 'PR draft' : 'PR') : 'Issue'), {
    id: 'type',
    header: 'Type',
    cell: (c) => <span className={`badge state-${c.row.original.state}`}>{c.getValue()}</span>,
  }),
  col.accessor((i) => `${i.repo}#${String(i.number).padStart(7, '0')}`, {
    id: 'ref',
    header: 'Ref',
    cell: (c) => (
      <>
        <FilterButton filter="repo" value={c.row.original.repo} />#{c.row.original.number}
      </>
    ),
  }),
  col.accessor((i) => i.title.toLowerCase(), {
    id: 'title',
    header: 'Title',
    cell: (c) => (
      <a href={c.row.original.url} target="_blank" rel="noreferrer" title={c.row.original.title}>
        {c.row.original.title}
      </a>
    ),
  }),
  col.accessor((i) => i.author ?? '', {
    id: 'author',
    header: 'Author',
    cell: (c) =>
      c.getValue() && (
        <>
          <FilterButton filter="author" value={c.getValue()} />
          {!isMember(c.row.original) && <span className="badge community" title="Community contributor">ext</span>}
        </>
      ),
  }),
  col.accessor((i) => i.assignees.join(', '), { id: 'assignees', header: 'Assignees' }),
  col.display({
    id: 'labels',
    header: 'Labels',
    cell: (c) =>
      c.row.original.labels.map((l) => (
        <FilterButton key={l.name} filter="label" value={l.name}>
          <span className="chip" style={{ background: `#${l.color}`, color: textColor(l.color) }}>
            {l.name}
          </span>
        </FilterButton>
      )),
  }),
  col.display({
    id: 'status',
    header: 'Review / CI',
    cell: (c) => {
      const { type, reviewDecision, ci } = c.row.original
      if (type !== 'pr') return null
      return (
        <>
          {reviewDecision && <span className={`badge review-${reviewDecision}`}>{reviewDecision.replace('_', ' ').toLowerCase()}</span>}
          {ci && <span className={`badge ci-${ci}`}>{ci.toLowerCase()}</span>}
        </>
      )
    },
  }),
  col.accessor('comments', { header: 'Comments' }),
  col.accessor((i) => Date.parse(i.createdAt), { id: 'created', header: 'Created', cell: (c) => <Time iso={c.row.original.createdAt} /> }),
  col.accessor((i) => Date.parse(i.updatedAt), { id: 'updated', header: 'Updated', cell: (c) => <Time iso={c.row.original.updatedAt} /> }),
])

const toSorting = (sort: string): SortingState =>
  sort ? [{ id: sort.replace(/^-/, ''), desc: sort.startsWith('-') }] : []
const fromSorting = ([first]: SortingState) => (first ? `${first.desc ? '-' : ''}${first.id}` : '')

function useUrlFilters() {
  const [filters, setFilters] = useState(() => parseFilters(location.search))
  useEffect(() => {
    const onPop = () => setFilters(parseFilters(location.search))
    addEventListener('popstate', onPop)
    return () => removeEventListener('popstate', onPop)
  }, [])
  const update = useCallback((patch: Partial<Filters>, replace = false) => {
    const next = { ...parseFilters(location.search), ...patch }
    const url = `${location.pathname}${serializeFilters(next) ? `?${serializeFilters(next)}` : ''}`
    if (replace) history.replaceState(null, '', url)
    else history.pushState(null, '', url)
    setFilters(next)
  }, [])
  return [filters, update] as const
}

function useData() {
  const [data, setData] = useState<ItemsResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/items')
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      setData(await res.json())
      setError(null)
    } catch (e) {
      setError(String(e))
    }
  }, [])
  const sync = useCallback(async () => {
    try {
      const res = await fetch('/api/sync', { method: 'POST' })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      const status: SyncStatus = await res.json()
      setData((d) => d && { ...d, sync: status })
      if (!status.running) await load()
    } catch (e) {
      setError(String(e))
    }
  }, [load])
  useEffect(() => void load(), [load])
  const running = data?.sync.running
  useEffect(() => {
    if (!running) return
    const timer = setInterval(load, 2000)
    return () => clearInterval(timer)
  }, [running, load])
  return { data, error, sync }
}

type Counts = [string, number][]

function Single({ label, value, counts, onChange, anyLabel = 'Any' }: { label: string; value: string; counts: Counts; onChange: (v: string) => void; anyLabel?: string }) {
  const options = value && !counts.some(([v]) => v === value) ? [...counts, [value, 0] as [string, number]] : counts
  return (
    <label>
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{anyLabel}</option>
        {options.map(([v, n]) => (
          <option key={v} value={v}>
            {v} ({n})
          </option>
        ))}
      </select>
    </label>
  )
}

function Multi({ label, values, counts, onChange, open }: { label: string; values: string[]; counts: Counts; onChange: (v: string[]) => void; open?: boolean }) {
  const options = [...counts, ...values.filter((v) => !counts.some(([c]) => c === v)).map((v) => [v, 0] as [string, number])]
  return (
    <details open={open || values.length > 0}>
      <summary>
        {label}
        {values.length > 0 && ` (${values.length})`}
      </summary>
      <fieldset>
        <legend className="sr-only">{label}</legend>
        {options.map(([v, n]) => (
          <label key={v} className="check">
            <input
              type="checkbox"
              checked={values.includes(v)}
              onChange={(e) => onChange(e.target.checked ? [...values, v] : values.filter((x) => x !== v))}
            />
            <span>{v}</span>
            <span className="count">{n}</span>
          </label>
        ))}
      </fieldset>
    </details>
  )
}

function Sidebar({ items, filters, update }: { items: Item[]; filters: Filters; update: (p: Partial<Filters>, replace?: boolean) => void }) {
  const facet = (key: keyof Filters, values: (i: Item) => (string | null)[]) =>
    countBy(filterItems(items, { ...filters, [key]: Array.isArray(filters[key]) ? [] : DEFAULT_FILTERS[key] }), values)
  const prOnly = (pick: (i: Item) => string | null) => (i: Item) => (i.type === 'pr' ? [pick(i)] : [])

  return (
    <aside>
      <label>
        Search
        <input type="search" placeholder="title or repo#123" value={filters.q} onChange={(e) => update({ q: e.target.value }, true)} />
      </label>
      <Single label="Type" anyLabel="All" value={filters.type} counts={facet('type', (i) => [i.type])} onChange={(v) => update({ type: v as Filters['type'] })} />
      <Multi label="State" open values={filters.state} counts={facet('state', (i) => [i.state])} onChange={(v) => update({ state: v as Filters['state'] })} />
      <Multi label="Repository" values={filters.repo} counts={facet('repo', (i) => [i.repo])} onChange={(repo) => update({ repo })} />
      <Multi label="Labels (all of)" values={filters.label} counts={facet('label', (i) => i.labels.map((l) => l.name))} onChange={(label) => update({ label })} />
      <Single label="Author" value={filters.author} counts={facet('author', (i) => (i.author ? [i.author] : []))} onChange={(author) => update({ author })} />
      <Single label="Author type" value={filters.who} counts={facet('who', (i) => [isMember(i) ? 'member' : 'community'])} onChange={(v) => update({ who: v as Filters['who'] })} />
      <Single label="Assignee" value={filters.assignee} counts={facet('assignee', (i) => (i.assignees.length ? i.assignees : [NONE]))} onChange={(assignee) => update({ assignee })} />
      <Single label="Review requested" value={filters.reviewer} counts={facet('reviewer', (i) => i.reviewRequests)} onChange={(reviewer) => update({ reviewer })} />
      <Single label="Draft" value={filters.draft} counts={facet('draft', prOnly((i) => (i.draft ? 'yes' : 'no')))} onChange={(v) => update({ draft: v as Filters['draft'] })} />
      <Single label="Review decision" value={filters.review} counts={facet('review', prOnly((i) => i.reviewDecision))} onChange={(review) => update({ review })} />
      <Single label="CI" value={filters.ci} counts={facet('ci', prOnly((i) => i.ci))} onChange={(ci) => update({ ci })} />
      <label>
        Updated within (days)
        <input type="number" min={0} value={filters.updatedWithin || ''} onChange={(e) => update({ updatedWithin: Number(e.target.value) }, true)} />
      </label>
      <label>
        Not updated for (days)
        <input type="number" min={0} value={filters.staleFor || ''} onChange={(e) => update({ staleFor: Number(e.target.value) }, true)} />
      </label>
      <button type="button" onClick={() => update({ ...DEFAULT_FILTERS, sort: filters.sort })}>
        Reset filters
      </button>
    </aside>
  )
}

export function App() {
  const [filters, update] = useUrlFilters()
  const { data, error, sync } = useData()
  const items = data?.items ?? EMPTY
  const filtered = useMemo(() => filterItems(items, filters), [items, filters])
  const sorting = useMemo(() => toSorting(filters.sort), [filters.sort])
  const onSortingChange = (updater: Updater<SortingState>) =>
    update({ sort: fromSorting(typeof updater === 'function' ? updater(sorting) : updater) })

  const table = useTable({
    features,
    columns,
    data: filtered,
    getRowId: (i) => i.id,
    state: { sorting },
    onSortingChange,
    enableSortingRemoval: false,
    enableMultiSort: false,
  })
  const rows = table.getRowModel().rows

  const scrollRef = useRef<HTMLDivElement>(null)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  })

  const addFilter = (e: MouseEvent) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-filter]')
    const { filter, value } = target?.dataset ?? {}
    if (!value) return
    if (filter === 'author') update({ author: value })
    if (filter === 'repo' && !filters.repo.includes(value)) update({ repo: [...filters.repo, value] })
    if (filter === 'label' && !filters.label.includes(value)) update({ label: [...filters.label, value] })
  }

  return (
    <div className="layout">
      <header>
        <h1>{data?.org ?? 'GitHub org'}</h1>
        <output>
          {filtered.length} of {items.length} items
        </output>
        <span className="sync">
          {data?.sync.error && <span className="error">Sync error: {data.sync.error}</span>}
          {data?.sync.lastSyncAt ? (
            <>
              Last sync <Time iso={data.sync.lastSyncAt} />
            </>
          ) : (
            'Never synced'
          )}
          <button type="button" onClick={sync} disabled={!data || data.sync.running}>
            {data?.sync.running ? 'Syncing…' : 'Sync now'}
          </button>
        </span>
      </header>
      {error && <p className="error" role="alert">Failed to load: {error}</p>}
      <Sidebar items={items} filters={filters} update={update} />
      <main ref={scrollRef}>
        <table>
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {group.headers.map((header) => {
                  const sorted = header.column.getIsSorted()
                  return (
                    <th key={header.id} aria-sort={sorted ? (sorted === 'asc' ? 'ascending' : 'descending') : undefined}>
                      {header.column.getCanSort() ? (
                        <button type="button" className="link" onClick={header.column.getToggleSortingHandler()}>
                          <table.FlexRender header={header} />
                          {sorted && (sorted === 'asc' ? ' ▲' : ' ▼')}
                        </button>
                      ) : (
                        <table.FlexRender header={header} />
                      )}
                    </th>
                  )
                })}
              </tr>
            ))}
          </thead>
          <tbody style={{ height: virtualizer.getTotalSize() }} onClick={addFilter}>
            {virtualizer.getVirtualItems().map((v) => {
              const row = rows[v.index]
              return (
                <tr key={row.id} style={{ transform: `translateY(${v.start}px)` }}>
                  {row.getAllCells().map((cell) => (
                    <td key={cell.id} className={`col-${cell.column.id}`}>
                      <table.FlexRender cell={cell} />
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
        {data && !rows.length && <p className="empty">No items match these filters.</p>}
      </main>
    </div>
  )
}

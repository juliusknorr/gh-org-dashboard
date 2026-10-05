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
import type { Item, ItemsResponse, SavedView, SyncStatus } from '../../shared/types.ts'
import {
  DEFAULT_FILTERS,
  NONE,
  countBy,
  filterItems,
  authorKind,
  parseFilters,
  serializeFilters,
  type Filters,
} from './filters.ts'
import { LaunchDialog } from './LaunchDialog.tsx'
import { Details } from './Details.tsx'
import { Overview } from './Overview.tsx'
import { Team } from './Team.tsx'
import { CommentIcon, IssueOpenedIcon, SidebarCollapseIcon, SidebarExpandIcon, SyncIcon, TerminalIcon, XIcon } from '@primer/octicons-react'
import { AuthorBadge, CiIcon, ReviewIcon, StateIcon, Time, textColor } from './format.tsx'

const ROW_HEIGHT = 36
const SYNC_POLL_MS = 2000
const IDLE_POLL_MS = 30_000
const EMPTY: Item[] = []
const PRESET_KEY = 'preset'

const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { basic: sortFn_basic },
})
const col = createColumnHelper<typeof features, Item>()

const FilterButton = ({ filter, value, children }: { filter: 'author' | 'repo' | 'label'; value: string; children?: ReactNode }) => (
  <button type="button" className="link" data-filter={filter} data-value={value} title={`Filter by ${filter} ${value}`}>
    {children ?? value}
  </button>
)

const columns = col.columns([
  col.display({
    id: 'launch',
    header: () => <span className="sr-only">Claude</span>,
    cell: (c) => (
      <button type="button" className="icon-button" data-launch={c.row.original.id} title="Launch Claude Code" aria-label="Launch Claude Code">
        <TerminalIcon />
      </button>
    ),
  }),
  col.accessor((i) => (i.type === 'pr' ? (i.draft ? 'PR draft' : 'PR') : i.type === 'advisory' ? 'Advisory' : 'Issue'), {
    id: 'type',
    header: () => <IssueOpenedIcon aria-label="Type" />,
    cell: (c) => <StateIcon item={c.row.original} />,
  }),
  col.accessor((i) => `${i.repo}#${String(i.number).padStart(7, '0')}`, {
    id: 'ref',
    header: 'Ref',
    cell: (c) => (
      <>
        <FilterButton filter="repo" value={c.row.original.repo} />
        {c.row.original.type === 'advisory' ? ` ${c.row.original.id}` : `#${c.row.original.number}`}
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
          <AuthorBadge item={c.row.original} />
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
    header: 'Status',
    cell: (c) => {
      const { type, reviewDecision, ci } = c.row.original
      if (type !== 'pr') return null
      return (
        <>
          <span className="slot">{reviewDecision && <ReviewIcon state={reviewDecision} />}</span>
          <span className="slot">{ci && <CiIcon ci={ci} />}</span>
        </>
      )
    },
  }),
  col.accessor('comments', {
    header: () => <CommentIcon aria-label="Comments" />,
    cell: (c) =>
      c.getValue() > 0 && (
        <>
          <CommentIcon /> {c.getValue()}
        </>
      ),
  }),
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

function usePreset(presets: string[]) {
  const [stored, setStored] = useState(() => {
    try {
      return localStorage.getItem(PRESET_KEY)
    } catch {
      return null
    }
  })
  const preset = stored && presets.includes(stored) ? stored : (presets[0] ?? null)
  const setPreset = (name: string) => {
    try {
      localStorage.setItem(PRESET_KEY, name)
    } catch {}
    setStored(name)
  }
  return [preset, setPreset] as const
}

function useData() {
  const [all, setData] = useState<ItemsResponse | null>(null)
  const [preset, setPreset] = usePreset(Object.keys(all?.presets ?? {}))
  const data = useMemo(() => {
    if (!all || !preset) return all
    const repos = new Set(all.presets[preset].map((r) => r.toLowerCase()))
    return { ...all, items: all.items.filter((i) => repos.has(i.repo.toLowerCase())) }
  }, [all, preset])
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
      const res = await fetch('/api/sync', { method: 'POST', headers: { 'content-type': 'application/json' } })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      const status: SyncStatus = await res.json()
      setData((d) => d && { ...d, sync: status })
      if (!status.running) await load()
    } catch (e) {
      setError(String(e))
    }
  }, [load])
  const replaceItem = useCallback(
    (item: Item) => setData((d) => d && { ...d, items: d.items.map((i) => (i.id === item.id ? item : i)) }),
    [],
  )
  useEffect(() => void load(), [load])
  const running = data?.sync.running
  const lastSyncAt = data?.sync.lastSyncAt
  useEffect(() => {
    const poll = async () => {
      try {
        const res = await fetch('/api/sync')
        if (!res.ok) return
        const status: SyncStatus = await res.json()
        if (status.lastSyncAt !== lastSyncAt) return load()
        if (status.running !== running) setData((d) => d && { ...d, sync: status })
      } catch {}
    }
    const timer = setInterval(poll, running ? SYNC_POLL_MS : IDLE_POLL_MS)
    return () => clearInterval(timer)
  }, [running, lastSyncAt, load])
  return { data, error, sync, replaceItem, preset, setPreset }
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

function useViews() {
  const [views, setViews] = useState<SavedView[]>([])
  useEffect(() => {
    fetch('/api/views')
      .then((res) => (res.ok ? res.json() : []))
      .then(setViews, () => {})
  }, [])
  const save = async (next: SavedView[]) => {
    const res = await fetch('/api/views', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(next) })
    const json = await res.json().catch(() => ({}))
    if (res.ok) setViews(json)
    else alert(`Saving views failed: ${json.error ?? res.statusText}`)
  }
  return [views, save] as const
}

function SavedViews({ filters, preset, setPreset }: { filters: Filters } & Pick<Data, 'preset' | 'setPreset'>) {
  const [views, save] = useViews()
  const current = serializeFilters({ ...filters, item: '' })
  const add = () => {
    const name = prompt('Name for this view')?.trim()
    if (name) save([...views.filter((v) => v.name !== name), { name, search: current, preset }])
  }
  return (
    <section className="views">
      <h2>Saved views</h2>
      {views.length > 0 && (
        <ul>
          {views.map((v) => (
            <li key={v.name}>
              <a
                href={v.search ? `/?${v.search}` : '/'}
                aria-current={v.search === current && (!v.preset || v.preset === preset) ? 'page' : undefined}
                onClick={() => v.preset && setPreset(v.preset)}
              >
                {v.name}
                {v.preset && v.preset !== preset && <span className="muted"> · {v.preset}</span>}
              </a>
              <button type="button" className="link" aria-label={`Remove ${v.name}`} title="Remove" onClick={() => save(views.filter((x) => x !== v))}>
                <XIcon />
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" onClick={add}>
        Save current filters
      </button>
    </section>
  )
}

function Sidebar({
  items,
  filters,
  update,
  preset,
  setPreset,
}: { items: Item[]; filters: Filters; update: (p: Partial<Filters>, replace?: boolean) => void } & Pick<Data, 'preset' | 'setPreset'>) {
  const facet = (key: keyof Filters, values: (i: Item) => (string | null)[]) =>
    countBy(filterItems(items, { ...filters, [key]: Array.isArray(filters[key]) ? [] : DEFAULT_FILTERS[key] }), values)
  const prOnly = (pick: (i: Item) => string | null) => (i: Item) => (i.type === 'pr' ? [pick(i)] : [])
  const issueOnly = (pick: (i: Item) => string | null) => (i: Item) => (i.type === 'issue' ? [pick(i)] : [])

  return (
    <aside>
      <SavedViews filters={filters} preset={preset} setPreset={setPreset} />
      <label>
        Search
        <input type="search" placeholder="title or repo#123" value={filters.q} onChange={(e) => update({ q: e.target.value }, true)} />
      </label>
      <Single label="Type" anyLabel="All" value={filters.type} counts={facet('type', (i) => [i.type])} onChange={(v) => update({ type: v as Filters['type'] })} />
      <Multi label="State" open values={filters.state} counts={facet('state', (i) => [i.state])} onChange={(v) => update({ state: v as Filters['state'] })} />
      <Multi label="Repository" values={filters.repo} counts={facet('repo', (i) => [i.repo])} onChange={(repo) => update({ repo })} />
      <Multi label="Labels (all of)" values={filters.label} counts={facet('label', (i) => i.labels.map((l) => l.name))} onChange={(label) => update({ label })} />
      <Single label="Author" value={filters.author} counts={facet('author', (i) => (i.author ? [i.author] : []))} onChange={(author) => update({ author })} />
      <Single label="Author type" value={filters.who} counts={facet('who', (i) => [authorKind(i)])} onChange={(v) => update({ who: v as Filters['who'] })} />
      <Single label="Assignee" value={filters.assignee} counts={facet('assignee', (i) => (i.assignees.length ? i.assignees : [NONE]))} onChange={(assignee) => update({ assignee })} />
      <Single label="Review requested" value={filters.reviewer} counts={facet('reviewer', (i) => i.reviewRequests)} onChange={(reviewer) => update({ reviewer })} />
      <Single label="First review" value={filters.firstReview} counts={facet('firstReview', prOnly((i) => (i.firstReviewAt ? 'yes' : 'no')))} onChange={(v) => update({ firstReview: v as Filters['firstReview'] })} />
      <Single label="Triaged" value={filters.triaged} counts={facet('triaged', issueOnly((i) => (i.triagedAt ? 'yes' : 'no')))} onChange={(v) => update({ triaged: v as Filters['triaged'] })} />
      <Single label="Triaged by" value={filters.triagedBy} counts={facet('triagedBy', (i) => (i.triagedBy ? [i.triagedBy] : []))} onChange={(triagedBy) => update({ triagedBy })} />
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
      <label>
        Created
        <input placeholder="2026-01-01..2026-01-31" value={filters.created} onChange={(e) => update({ created: e.target.value.trim() }, true)} />
      </label>
      <label>
        Closed
        <input placeholder="2026-01-01..2026-01-31" value={filters.closed} onChange={(e) => update({ closed: e.target.value.trim() }, true)} />
      </label>
      <button type="button" onClick={() => update({ ...DEFAULT_FILTERS, sort: filters.sort, item: filters.item })}>
        Reset filters
      </button>
    </aside>
  )
}

type Data = ReturnType<typeof useData>

const FILTERS_HIDDEN_KEY = 'filters-hidden'

function useFiltersHidden() {
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(FILTERS_HIDDEN_KEY) === '1'
    } catch {
      return false
    }
  })
  const toggle = () =>
    setHidden((h) => {
      try {
        localStorage.setItem(FILTERS_HIDDEN_KEY, h ? '0' : '1')
      } catch {}
      return !h
    })
  return [hidden, toggle] as const
}

function Items({ data, error, sync, replaceItem, preset, setPreset }: Data) {
  const [filtersHidden, toggleFilters] = useFiltersHidden()
  const [filters, update] = useUrlFilters()
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
    scrollMargin: ROW_HEIGHT,
    scrollPaddingStart: ROW_HEIGHT,
  })

  const [launchItem, setLaunchItem] = useState<Item | null>(null)

  const onTableClick = (e: MouseEvent) => {
    const launchId = (e.target as HTMLElement).closest<HTMLElement>('[data-launch]')?.dataset.launch
    if (launchId) return setLaunchItem(items.find((i) => i.id === launchId) ?? null)
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-filter]')
    const { filter, value } = target?.dataset ?? {}
    if (value) {
      if (filter === 'author') update({ author: value })
      if (filter === 'repo' && !filters.repo.includes(value)) update({ repo: [...filters.repo, value] })
      if (filter === 'label' && !filters.label.includes(value)) update({ label: [...filters.label, value] })
      return
    }
    if ((e.target as HTMLElement).closest('a, button, input, select, textarea')) return
    const rowId = (e.target as HTMLElement).closest<HTMLElement>('tr[data-id]')?.dataset.id
    if (rowId && rowId !== filters.item) update({ item: rowId })
  }

  const closeDetails = useCallback(() => update({ item: '' }), [update])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || document.querySelector('dialog[open], :popover-open')) return
      if (e.target instanceof Element && e.target.closest('input, textarea, select, [contenteditable]')) return
      if (e.key === 'Escape' && filters.item) return closeDetails()
      if (filters.item && e.key === 'l') {
        const item = items.find((i) => i.id === filters.item)
        return item && setLaunchItem(item)
      }
      const shortcut = filters.item && document.querySelector<HTMLElement>(`aside.details [data-shortcut="${CSS.escape(e.key)}"]`)
      if (shortcut) {
        e.preventDefault()
        shortcut.focus()
        return shortcut.click()
      }
      const step = { j: 1, k: -1 }[e.key]
      if (!step || !rows.length) return
      const current = rows.findIndex((r) => r.id === filters.item)
      const next = current < 0 ? (step > 0 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, current + step))
      update({ item: rows[next].id }, true)
      virtualizer.scrollToIndex(next)
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  })

  return (
    <div className={['layout', filters.item && 'with-details', filtersHidden && 'filters-hidden'].filter(Boolean).join(' ')}>
      <Header data={data} sync={sync} preset={preset} setPreset={setPreset}>
        <button
          type="button"
          className="icon-button"
          onClick={toggleFilters}
          aria-pressed={!filtersHidden}
          aria-label={filtersHidden ? 'Show filters' : 'Hide filters'}
          title={filtersHidden ? 'Show filters' : 'Hide filters'}
        >
          {filtersHidden ? <SidebarCollapseIcon /> : <SidebarExpandIcon />}
        </button>
        <output>
          {filtered.length} of {items.length} items
        </output>
      </Header>
      {error && <p className="error" role="alert">Failed to load: {error}</p>}
      {!filtersHidden && <Sidebar items={items} filters={filters} update={update} preset={preset} setPreset={setPreset} />}
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
          <tbody style={{ height: virtualizer.getTotalSize() }} onClick={onTableClick}>
            {virtualizer.getVirtualItems().map((v) => {
              const row = rows[v.index]
              return (
                <tr key={row.id} data-id={row.id} aria-selected={row.id === filters.item} style={{ transform: `translateY(${v.start - ROW_HEIGHT}px)` }}>
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
      {filters.item && (
        <Details key={filters.item} id={filters.item} listItem={items.find((i) => i.id === filters.item)} onItem={replaceItem} onClose={closeDetails} />
      )}
      {launchItem && <LaunchDialog key={launchItem.id} item={launchItem} onClose={() => setLaunchItem(null)} />}
    </div>
  )
}

const PAGES = [
  ['/', 'Items'],
  ['/overview', 'Overview'],
  ['/team', 'Team'],
] as const

function Header({ data, sync, preset, setPreset, children }: Pick<Data, 'data' | 'sync' | 'preset' | 'setPreset'> & { children?: ReactNode }) {
  const presets = Object.keys(data?.presets ?? {})
  return (
    <header>
      {presets.length > 1 ? (
        <h1>
          <select className="preset" value={preset ?? ''} onChange={(e) => setPreset(e.target.value)} aria-label="Team preset">
            {presets.map((name) => (
              <option key={name}>{name}</option>
            ))}
          </select>
        </h1>
      ) : (
        <h1>{preset ?? 'GitHub org'}</h1>
      )}
      <nav className="tabs">
        {PAGES.map(([path, label]) => (
          <a key={path} href={path} aria-current={location.pathname === path ? 'page' : undefined}>
            {label}
          </a>
        ))}
      </nav>
      {children}
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
          <SyncIcon className={data?.sync.running ? 'spin' : undefined} /> {data?.sync.running ? 'Syncing…' : 'Sync'}
        </button>
      </span>
    </header>
  )
}

function useLocation() {
  const [url, setUrl] = useState(() => location.pathname + location.search)
  useEffect(() => {
    const onPop = () => setUrl(location.pathname + location.search)
    const onClick = (e: globalThis.MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
      const a = (e.target as Element).closest?.('a')
      if (!a || a.target || a.hasAttribute('download') || a.origin !== location.origin) return
      e.preventDefault()
      history.pushState(null, '', a.pathname + a.search)
      dispatchEvent(new PopStateEvent('popstate'))
    }
    addEventListener('popstate', onPop)
    addEventListener('click', onClick)
    return () => {
      removeEventListener('popstate', onPop)
      removeEventListener('click', onClick)
    }
  }, [])
  return new URL(url, location.origin)
}

export function App() {
  const { pathname, search } = useLocation()
  const data = useData()
  const items = useMemo(() => (data.data?.items ?? EMPTY).filter((i) => i.type !== 'advisory'), [data.data])
  if (pathname !== '/overview' && pathname !== '/team') return <Items {...data} />
  return (
    <div className="layout page">
      <Header data={data.data} sync={data.sync} preset={data.preset} setPreset={data.setPreset} />
      {data.error && <p className="error" role="alert">Failed to load: {data.error}</p>}
      <main>
        {pathname === '/team' ? <Team items={items} search={search} /> : <Overview items={items} search={search} />}
      </main>
    </div>
  )
}

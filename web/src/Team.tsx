import { useEffect, useMemo, useState } from 'react'
import { MarkGithubIcon } from '@primer/octicons-react'
import type { Activity, Item } from '../../shared/types.ts'
import { DAY, RANGES, isoDate } from './overview.ts'
import { GROUPS, STALE_DAYS, members, rangeStart, reviewsPerWeek, summary, team, type Group, type Metric, type Summary, type Team as TeamData } from './team.ts'
import { StateIcon, Time, itemRef } from './format.tsx'
import { orgOf } from './filters.ts'

const HOUR = 3_600_000
const duration = (ms: number) => (ms < 2 * DAY ? `${Math.round(ms / HOUR)}h` : `${Math.round(ms / DAY)}d`)

function teamHref(search: string, patch: Record<string, string>) {
  const p = new URLSearchParams(search)
  for (const [k, v] of Object.entries(patch)) v ? p.set(k, v) : p.delete(k)
  return `${location.pathname}?${p}`
}

function navigate(search: string, patch: Record<string, string>) {
  history.pushState(null, '', teamHref(search, patch))
  dispatchEvent(new PopStateEvent('popstate'))
}

const DurationCard = ({ label, noun, value, metric }: { label: string; noun: string; value: number | null; metric: Metric }) => (
  <div className="team-card">
    <a className="team-value" href={metric.href}>
      {value === null ? '–' : duration(value)}
    </a>
    <span className="team-label">
      {label} · <a href={metric.href}>{metric.count} {noun}</a>
    </span>
  </div>
)

function useActivity(preset: string | null, org: string, logins: string[], from: number) {
  const [state, setState] = useState<{ key: string; data: Record<string, Activity> | null; error: string | null }>({ key: '', data: null, error: null })
  const key = preset && logins.length ? `/api/activity?${new URLSearchParams({ preset, org, logins: logins.join(','), from: isoDate(from) })}` : ''
  useEffect(() => {
    if (!key) return
    let current = true
    fetch(key)
      .then(async (res) => (res.ok ? res.json() : Promise.reject(new Error((await res.json().catch(() => ({}))).error ?? `${res.status} ${res.statusText}`))))
      .then(
        (data) => current && setState({ key, data, error: null }),
        (err) => current && setState({ key, data: null, error: String(err) }),
      )
    return () => {
      current = false
    }
  }, [key])
  return state.key === key ? state : { data: null, error: null }
}

type Row = Summary & { activity?: Activity }
type Cell = { value: number | null; href?: string; time?: boolean }
const count = (m: Metric): Cell => ({ value: m.count, href: m.href })
const COLUMNS: [key: string, label: string, cell: (s: Row) => Cell][] = [
  ['openPrs', 'Open PRs', (s) => count(s.openPrs)],
  ['openIssues', 'Open issues', (s) => count(s.openIssues)],
  ['reviewRequests', 'Pending reviews', (s) => count(s.reviewRequests)],
  ['assigned', 'Assigned open', (s) => count(s.assigned)],
  ['merged', 'PRs merged', (s) => count(s.merged)],
  ['reviewed', 'PRs reviewed', (s) => ({ value: s.activity?.reviewed ?? null })],
  ['commented', 'Commented on', (s) => ({ value: s.activity?.commented ?? null })],
  ['issuesClosed', 'Issues closed', (s) => count(s.issuesClosed)],
  ['review', 'Median to first review', (s) => ({ value: s.review.median, href: s.review.reviewed.href, time: true })],
  ['triaged', 'Issues triaged', (s) => count(s.triage.triaged)],
  ['triage', 'Median to triage', (s) => ({ value: s.triage.median, href: s.triage.triaged.href, time: true })],
  ['untriaged', 'Assigned untriaged', (s) => count(s.untriaged)],
]

function Members({ rows, search }: { rows: Row[]; search: string }) {
  const sort = new URLSearchParams(search).get('sort') ?? ''
  const key = sort.replace(/^-/, '')
  const desc = sort.startsWith('-')
  const column = COLUMNS.find(([k]) => k === key)
  const value = (s: Row) => column?.[2](s).value ?? null
  const sorted = column
    ? rows.toSorted((a, b) => {
        const [x, y] = [value(a), value(b)]
        if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1
        return desc ? y - x : x - y
      })
    : rows
  return (
    <div className="team-scroll">
      <table className="team-table team-members">
        <thead>
          <tr>
            <th>Member</th>
            {COLUMNS.map(([k, label]) => (
              <th key={k} aria-sort={k === key ? (desc ? 'descending' : 'ascending') : undefined}>
                <button type="button" className="link" onClick={() => navigate(search, { sort: k === key && desc ? k : `-${k}` })}>
                  {label}
                  {k === key && (desc ? ' ▼' : ' ▲')}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((s) => (
            <tr key={s.login}>
              <th scope="row">
                <a href={teamHref(search, { member: s.login })}>{s.login}</a>
              </th>
              {COLUMNS.map(([k, , cell]) => {
                const c = cell(s)
                return (
                  <td key={k}>
                    {c.value === null ? <span className="muted">–</span> : c.href ? <a href={c.href}>{c.time ? duration(c.value) : c.value}</a> : c.value}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const Card = ({ label, metric }: { label: string; metric: Metric }) => (
  <a className="team-card" href={metric.href}>
    <span className="team-value">{metric.count}</span>
    <span className="team-label">{label}</span>
  </a>
)

const ActivityCard = ({ label, value }: { label: string; value: number | undefined }) => (
  <div className="team-card" title="From GitHub contributions, limited to this preset's repositories">
    <span className="team-value">{value ?? '–'}</span>
    <span className="team-label">{label}</span>
  </div>
)

function ItemList({ title, items, more, date }: { title: string; items: Item[]; more?: Metric; date: 'createdAt' | 'updatedAt' | 'closedAt' }) {
  return (
    <section className="team-panel">
      <h3>
        {title} {more && <a href={more.href}>{more.count} total</a>}
      </h3>
      {items.length ? (
        <ul className="team-list">
          {items.map((i) => (
            <li key={i.id}>
              <StateIcon item={i} />
              <a href={`/?item=${encodeURIComponent(i.id)}`} title={i.title}>
                <span className="muted">
                  {itemRef(i)}
                </span>{' '}
                {i.title}
              </a>
              <span className="muted">
                <Time iso={i[date]!} />
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">None</p>
      )}
    </section>
  )
}

type Bar = { count: number; href?: string }
type Week = { start: number } & Record<string, Bar | number>

function WeekChart({ title, keys, series }: { title: string; keys: [key: string, label: string][]; series: Week[] }) {
  const [hover, setHover] = useState<number | null>(null)
  const get = (w: Week, key: string) => w[key] as Bar
  const max = Math.max(1, ...series.flatMap((w) => keys.map(([k]) => get(w, k).count)))
  const sum = (key: string) => series.reduce((n, w) => n + get(w, key).count, 0)
  const week = hover === null ? null : series[hover]
  const labelEvery = Math.ceil(series.length / 6)
  const counts = (count: (key: string) => number) =>
    keys.map(([k, label], n) => (
      <span key={k}>
        {n > 0 && ', '}
        <b>{count(k)}</b> {label.toLowerCase()}
      </span>
    ))
  const value = (m: Bar) => (m.href ? <a href={m.href}>{m.count}</a> : m.count)
  return (
    <section className="team-panel team-wide">
      <h3>{title}</h3>
      <div className="team-legend">
        {keys.map(([k, label], n) => (
          <span key={k}>
            <i className={`team-key team-series-${n + 1}`} /> {label}
          </span>
        ))}
        <output className="team-readout">
          {week ? (
            <>
              Week of {isoDate(week.start)}: {counts((k) => get(week, k).count)}
            </>
          ) : (
            <>In range: {counts(sum)}</>
          )}
        </output>
      </div>
      <div className="team-chart" onPointerLeave={() => setHover(null)} onBlur={() => setHover(null)}>
        <span className="team-max">{max}</span>
        <div className="team-plot">
          {series.map((w, n) => (
            <div key={w.start} className="team-week" onPointerEnter={() => setHover(n)} onFocus={() => setHover(n)}>
              {keys.map(([k, label], i) => {
                const m = get(w, k)
                const Tag = m.href ? 'a' : 'span'
                return (
                  <Tag key={k} href={m.href} tabIndex={0} className={`team-bar team-series-${i + 1}`} aria-label={`${m.count} ${label.toLowerCase()}, week of ${isoDate(w.start)}`}>
                    <span style={{ height: `${(m.count / max) * 100}%` }} />
                  </Tag>
                )
              })}
              <span className="team-tick">{n % labelEvery === 0 && isoDate(w.start).slice(5)}</span>
            </div>
          ))}
        </div>
      </div>
      <details>
        <summary>Table</summary>
        <table className="team-table">
          <thead>
            <tr>
              <th>Week of</th>
              {keys.map(([k, label]) => (
                <th key={k}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {series.map((w) => (
              <tr key={w.start}>
                <td>{isoDate(w.start)}</td>
                {keys.map(([k]) => (
                  <td key={k}>{value(get(w, k))}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </section>
  )
}

function Repos({ repos }: { repos: TeamData['repos'] }) {
  const max = repos[0]?.count ?? 1
  return (
    <section className="team-panel">
      <h3>Repositories with authored items updated in range</h3>
      {repos.length ? (
        <ul className="team-repos">
          {repos.slice(0, 10).map((r) => (
            <li key={r.repo}>
              <a href={r.href}>
                <span className="team-repo">{r.repo}</span>
                <span className="team-track">
                  <span style={{ width: `${(r.count / max) * 100}%` }} />
                </span>
                <span className="team-count">{r.count}</span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">None</p>
      )}
      {repos.length > 10 && <p className="muted">+{repos.length - 10} more</p>}
    </section>
  )
}

export function Team({ items, search, preset, core }: { items: Item[]; search: string; preset: string | null; core: string[] }) {
  const params = new URLSearchParams(search)
  const weeks = RANGES.includes(Number(params.get('weeks'))) ? Number(params.get('weeks')) : 12
  const login = params.get('member') ?? ''
  const group = (params.get('group') ?? 'core') as Group
  const org = params.get('org') ?? ''
  const orgs = useMemo(() => [...new Set(items.map(orgOf))].sort(), [items])
  const people = useMemo(() => members(org ? items.filter((i) => orgOf(i) === org) : items, weeks, Date.now(), core, group), [items, org, weeks, core, group])
  const summaries = useMemo(() => (login ? [] : people.map((m) => summary(items, m.login, weeks, Date.now(), org))), [items, people, login, weeks, org])
  const t = useMemo(() => (login ? team(items, login, weeks, Date.now(), org) : null), [items, login, weeks, org])
  // ponytail: server caps /api/activity at 100 logins, members beyond the most active 100 show no review stats
  const logins = useMemo(() => (login ? [login] : people.slice(0, 100).map((m) => m.login)), [login, people])
  const activity = useActivity(preset, org, logins, rangeStart(weeks, Date.now()))
  const reviewSeries = useMemo(() => (t ? reviewsPerWeek(t.series, activity.data?.[login]?.reviews ?? []) : []), [t, activity.data, login])
  const rows = summaries.map((s) => ({ ...s, activity: activity.data?.[s.login] }))

  return (
    <div className="team">
      <div className="team-filters">
        {login && <a href={teamHref(search, { member: '' })}>Back to team</a>}
        {orgs.length > 1 && (
          <label>
            Org
            <select value={org} onChange={(e) => navigate(search, { org: e.target.value })}>
              <option value="">All orgs</option>
              {orgs.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Group
          <select value={group} onChange={(e) => navigate(search, { group: e.target.value === 'core' ? '' : e.target.value })}>
            {Object.entries(GROUPS).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Member
          <select value={login} title="Count: authored items updated in range" onChange={(e) => navigate(search, { member: e.target.value })}>
            <option value="">All members</option>
            {people.map((m) => (
              <option key={m.login} value={m.login}>
                {m.login} ({m.active})
              </option>
            ))}
            {login && !people.some((m) => m.login === login) && <option value={login}>{login}</option>}
          </select>
        </label>
        <label>
          Range
          <select value={weeks} onChange={(e) => navigate(search, { weeks: e.target.value })}>
            {RANGES.map((w) => (
              <option key={w} value={w}>
                {w === 1 ? '1 week' : `${w} weeks`}
              </option>
            ))}
          </select>
        </label>
        <span className="muted">since {isoDate(rangeStart(weeks, Date.now()))}</span>
        {activity.error && <span className="error" role="alert">Reviews and comments: {activity.error}</span>}
      </div>
      {!t ? (
        rows.length ? (
          <Members rows={rows} search={search} />
        ) : (
          <p className="empty">No team members found. Set a core team for this preset in Settings, otherwise org members who authored items are listed.</p>
        )
      ) : (
        <>
          <h2 className="team-name">
            {login}
            <a href={`https://github.com/${encodeURIComponent(login)}`} target="_blank" rel="noreferrer" aria-label={`${login} on GitHub`}>
              <MarkGithubIcon />
            </a>
          </h2>
          <div className="team-cards">
            <Card label="Open PRs" metric={t.openPrs} />
            <Card label="Open issues" metric={t.openIssues} />
            <Card label="Pending reviews" metric={t.reviewRequests} />
            <Card label="Assigned open" metric={t.assigned} />
            <Card label="PRs merged" metric={t.merged} />
            <ActivityCard label="PRs reviewed" value={activity.data?.[login]?.reviewed} />
            <ActivityCard label="Commented on" value={activity.data?.[login]?.commented} />
            <Card label="Issues closed" metric={t.issuesClosed} />
            <DurationCard label="Median to first review" noun="reviewed" value={t.review.median} metric={t.review.reviewed} />
            <DurationCard label="Median to triage, community issues" noun="triaged" value={t.triage.median} metric={t.triage.triaged} />
            <Card label="Assigned untriaged" metric={t.untriaged} />
          </div>
          <div className="team-grid">
            <WeekChart title="Pull requests per week" keys={[['opened', 'Opened'], ['merged', 'Merged']]} series={t.series} />
            <WeekChart title="Issues triaged per week" keys={[['triaged', 'Triaged']]} series={t.series} />
            <WeekChart title="PRs reviewed per week" keys={[['reviewed', 'Reviewed']]} series={reviewSeries} />
            <ItemList title="Merged PRs in range" items={t.merged.list.toSorted((a, b) => b.closedAt!.localeCompare(a.closedAt!))} more={t.merged} date="closedAt" />
            <ItemList title="Oldest open PRs" items={t.oldestPrs} more={t.openPrs} date="createdAt" />
            <ItemList title={`Assigned, no update for ${STALE_DAYS}+ days`} items={t.stale.list} more={t.stale} date="updatedAt" />
            <Repos repos={t.repos} />
          </div>
        </>
      )}
    </div>
  )
}

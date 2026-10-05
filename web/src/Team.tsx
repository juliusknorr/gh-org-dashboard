import { useMemo, useState } from 'react'
import { MarkGithubIcon } from '@primer/octicons-react'
import type { Item } from '../../shared/types.ts'
import { DAY, RANGES, isoDate } from './overview.ts'
import { STALE_DAYS, members, rangeStart, summary, team, type Metric, type Summary, type Team as TeamData } from './team.ts'
import { StateIcon, Time, itemRef } from './format.tsx'

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

type Cell = { value: number | null; href: string; time?: boolean }
const count = (m: Metric): Cell => ({ value: m.count, href: m.href })
const COLUMNS: [key: string, label: string, cell: (s: Summary) => Cell][] = [
  ['openPrs', 'Open PRs', (s) => count(s.openPrs)],
  ['openIssues', 'Open issues', (s) => count(s.openIssues)],
  ['reviewRequests', 'Review requests', (s) => count(s.reviewRequests)],
  ['assigned', 'Assigned open', (s) => count(s.assigned)],
  ['merged', 'PRs merged', (s) => count(s.merged)],
  ['issuesClosed', 'Issues closed', (s) => count(s.issuesClosed)],
  ['review', 'Median to first review', (s) => ({ value: s.review.median, href: s.review.reviewed.href, time: true })],
  ['triaged', 'Issues triaged', (s) => count(s.triage.triaged)],
  ['triage', 'Median to triage', (s) => ({ value: s.triage.median, href: s.triage.triaged.href, time: true })],
  ['untriaged', 'Assigned untriaged', (s) => count(s.untriaged)],
]

function Members({ rows, search }: { rows: Summary[]; search: string }) {
  const sort = new URLSearchParams(search).get('sort') ?? ''
  const key = sort.replace(/^-/, '')
  const desc = sort.startsWith('-')
  const column = COLUMNS.find(([k]) => k === key)
  const value = (s: Summary) => column?.[2](s).value ?? null
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
                    {c.value === null ? <span className="muted">–</span> : <a href={c.href}>{c.time ? duration(c.value) : c.value}</a>}
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

function ItemList({ title, items, more, date }: { title: string; items: Item[]; more?: Metric; date: 'createdAt' | 'updatedAt' }) {
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
                <Time iso={i[date]} />
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

function WeekChart({ series }: { series: TeamData['series'] }) {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(1, ...series.flatMap((w) => [w.opened.count, w.merged.count]))
  const sum = (key: 'opened' | 'merged') => series.reduce((n, w) => n + w[key].count, 0)
  const week = hover === null ? null : series[hover]
  const labelEvery = Math.ceil(series.length / 6)
  const bar = (m: Metric, kind: 'opened' | 'merged', start: number) => (
    <a href={m.href} className={`team-bar team-${kind}`} aria-label={`${m.count} ${kind}, week of ${isoDate(start)}`}>
      <span style={{ height: `${(m.count / max) * 100}%` }} />
    </a>
  )
  return (
    <section className="team-panel team-wide">
      <h3>Pull requests per week</h3>
      <div className="team-legend">
        <span>
          <i className="team-key team-opened" /> Opened
        </span>
        <span>
          <i className="team-key team-merged" /> Merged
        </span>
        <output className="team-readout">
          {week ? (
            <>
              Week of {isoDate(week.start)}: <b>{week.opened.count}</b> opened, <b>{week.merged.count}</b> merged
            </>
          ) : (
            <>
              In range: <b>{sum('opened')}</b> opened, <b>{sum('merged')}</b> merged
            </>
          )}
        </output>
      </div>
      <div className="team-chart" onPointerLeave={() => setHover(null)} onBlur={() => setHover(null)}>
        <span className="team-max">{max}</span>
        <div className="team-plot">
          {series.map((w, n) => (
            <div key={w.start} className="team-week" onPointerEnter={() => setHover(n)} onFocus={() => setHover(n)}>
              {bar(w.opened, 'opened', w.start)}
              {bar(w.merged, 'merged', w.start)}
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
              <th>Opened</th>
              <th>Merged</th>
            </tr>
          </thead>
          <tbody>
            {series.map((w) => (
              <tr key={w.start}>
                <td>{isoDate(w.start)}</td>
                <td>
                  <a href={w.opened.href}>{w.opened.count}</a>
                </td>
                <td>
                  <a href={w.merged.href}>{w.merged.count}</a>
                </td>
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

export function Team({ items, search }: { items: Item[]; search: string }) {
  const params = new URLSearchParams(search)
  const weeks = RANGES.includes(Number(params.get('weeks'))) ? Number(params.get('weeks')) : 12
  const login = params.get('member') ?? ''
  const people = useMemo(() => members(items, weeks), [items, weeks])
  const rows = useMemo(() => (login ? [] : people.map((m) => summary(items, m.login, weeks))), [items, people, login, weeks])
  const t = useMemo(() => (login ? team(items, login, weeks) : null), [items, login, weeks])

  return (
    <div className="team">
      <div className="team-filters">
        {login && <a href={teamHref(search, { member: '' })}>Back to team</a>}
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
                {w} weeks
              </option>
            ))}
          </select>
        </label>
        <span className="muted">since {isoDate(rangeStart(weeks, Date.now()))}</span>
      </div>
      {!t ? (
        rows.length ? (
          <Members rows={rows} search={search} />
        ) : (
          <p className="empty">No team members found. Members are authors with a member, owner or collaborator association.</p>
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
            <Card label="Review requests" metric={t.reviewRequests} />
            <Card label="Assigned open" metric={t.assigned} />
            <Card label="PRs merged" metric={t.merged} />
            <Card label="Issues closed" metric={t.issuesClosed} />
            <DurationCard label="Median to first review" noun="reviewed" value={t.review.median} metric={t.review.reviewed} />
            <DurationCard label="Median to triage, community issues" noun="triaged" value={t.triage.median} metric={t.triage.triaged} />
            <Card label="Assigned untriaged" metric={t.untriaged} />
          </div>
          <div className="team-grid">
            <WeekChart series={t.series} />
            <ItemList title="Oldest open PRs" items={t.oldestPrs} more={t.openPrs} date="createdAt" />
            <ItemList title={`Assigned, no update for ${STALE_DAYS}+ days`} items={t.stale.list} more={t.stale} date="updatedAt" />
            <Repos repos={t.repos} />
          </div>
        </>
      )}
    </div>
  )
}

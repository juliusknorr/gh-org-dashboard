import { useMemo, useState } from 'react'
import { MarkGithubIcon } from '@primer/octicons-react'
import type { Item } from '../../shared/types.ts'
import { DAY, RANGES, isoDate } from './overview.ts'
import { STALE_DAYS, members, team, type Metric, type Team as TeamData } from './team.ts'
import { StateIcon, Time } from './format.tsx'

const HOUR = 3_600_000
const duration = (ms: number) => (ms < 2 * DAY ? `${Math.round(ms / HOUR)}h` : `${Math.round(ms / DAY)}d`)

function navigate(search: string, patch: Record<string, string>) {
  const p = new URLSearchParams(search)
  for (const [k, v] of Object.entries(patch)) p.set(k, v)
  history.pushState(null, '', `${location.pathname}?${p}`)
  dispatchEvent(new PopStateEvent('popstate'))
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
                  {i.repo}#{i.number}
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
  const people = useMemo(() => members(items, weeks), [items, weeks])
  const login = params.get('member') || people[0]?.login || ''
  const t = useMemo(() => (login ? team(items, login, weeks) : null), [items, login, weeks])

  return (
    <div className="team">
      <div className="team-filters">
        <label>
          Member
          <select value={login} title="Count: authored items updated in range" onChange={(e) => navigate(search, { member: e.target.value })}>
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
        {t && <span className="muted">since {isoDate(t.from)}</span>}
      </div>
      {!t ? (
        <p className="empty">No team members found. Members are authors with a member, owner or collaborator association.</p>
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
            <div className="team-card">
              <a className="team-value" href={t.review.reviewed.href} title={`${t.review.reviewed.count} reviewed PRs`}>
                {t.review.median === null ? '–' : duration(t.review.median)}
              </a>
              <span className="team-label">
                Median to first review, <a href={t.review.unreviewed.href}>{t.review.unreviewed.count} unreviewed</a>
              </span>
            </div>
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

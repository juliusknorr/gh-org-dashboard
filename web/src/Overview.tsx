import { useMemo, type ReactNode } from 'react'
import type { Item } from '../../shared/types.ts'
import { isMember } from './filters.ts'
import { StateIcon, Time } from './format.tsx'
import { DAY, RANGES, isoDate, overview, weekRange, type Week } from './overview.ts'

const DEFAULT_WEEKS = 12
const HOUR = 3_600_000
const ALL = { state: '' }
const DONE = [['state', 'closed'], ['state', 'merged']]
const WAITING = { type: 'pr', draft: 'no', firstReview: 'no' }

const to = (params: Record<string, string | number> | string[][]) =>
  `/?${new URLSearchParams(Array.isArray(params) ? params : Object.entries(params).map(([k, v]) => [k, String(v)]))}`

const duration = (ms: number | null) =>
  ms === null ? '–' : ms < 2 * DAY ? `${Math.round(ms / HOUR)}h` : `${(ms / DAY).toFixed(ms < 10 * DAY ? 1 : 0)}d`

function Stat({ href, value, label }: { href: string; value: ReactNode; label: string }) {
  return (
    <a className="ov-stat" href={href}>
      <strong>{value}</strong>
      <span>{label}</span>
    </a>
  )
}

interface Series {
  label: string
  className: string
  value: (w: Week) => number | null
  href: (w: Week) => string
  format?: (v: number) => string
}

function WeekChart({ title, weeks, series }: { title: string; weeks: Week[]; series: Series[] }) {
  const max = Math.max(1, ...weeks.flatMap((w) => series.map((s) => s.value(w) ?? 0)))
  const format = series[0].format ?? String
  return (
    <figure className="ov-chart">
      <figcaption>
        <span>{title}</span>
        {series.length > 1 && (
          <span className="ov-legend">
            {series.map((s) => (
              <span key={s.label}>
                <i className={s.className} /> {s.label}
              </span>
            ))}
          </span>
        )}
      </figcaption>
      <div className="ov-plot">
        <span className="ov-max">{format(max)}</span>
        <div className="ov-cols">
          {weeks.map((w) => (
            <div key={w.start} className="ov-col">
              {series.map((s) => {
                const v = s.value(w)
                const label = `${s.label}, week of ${isoDate(w.start)}: ${v === null ? 'no data' : format(v)}`
                return (
                  <a key={s.label} href={s.href(w)} title={label} aria-label={label}>
                    <span className={s.className} style={{ height: `${((v ?? 0) / max) * 100}%` }} />
                  </a>
                )
              })}
            </div>
          ))}
        </div>
      </div>
      <div className="ov-axis">
        <span>{isoDate(weeks[0].start)}</span>
        <span>{isoDate(weeks.at(-1)!.start)}</span>
      </div>
    </figure>
  )
}

function ItemList({ items, link, date }: { items: Item[]; link: (i: Item) => string; date: (i: Item) => string }) {
  if (!items.length) return <p className="muted">None</p>
  return (
    <ol className="ov-list">
      {items.map((i) => (
        <li key={i.id}>
          <StateIcon item={i} />
          <a href={link(i)} title={i.title}>
            <span className="muted">
              {i.repo}#{i.number}
            </span>{' '}
            {i.title}
          </a>
          <Time iso={date(i)} />
        </li>
      ))}
    </ol>
  )
}

function Section({ title, more, children, wide }: { title: string; more?: [string, string]; children: ReactNode; wide?: boolean }) {
  return (
    <section className={wide ? 'ov-card wide' : 'ov-card'}>
      <h2>
        {title}
        {more && <a href={more[0]}>{more[1]}</a>}
      </h2>
      {children}
    </section>
  )
}

export function Overview({ items, search }: { items: Item[]; search: string }) {
  const requested = Number(new URLSearchParams(search).get('weeks'))
  const weeks = RANGES.includes(requested) ? requested : DEFAULT_WEEKS
  const o = useMemo(() => overview(items, weeks), [items, weeks])
  const since = `${isoDate(o.from)}..`
  const maxRepo = Math.max(1, ...o.repos.map((r) => r.issues + r.prs))
  const opened = (type: string) => (w: Week) => to({ ...ALL, type, created: weekRange(w.start), sort: 'created' })
  const closed = (type: string) => (w: Week) => to([...DONE, ['type', type], ['closed', weekRange(w.start)]])

  return (
    <div className="overview">
      <nav className="ov-range" aria-label="Range">
        {RANGES.map((n) => (
          <a key={n} href={`/overview?weeks=${n}`} aria-current={n === weeks ? 'true' : undefined}>
            {n} weeks
          </a>
        ))}
        <span className="muted">since {isoDate(o.from)}</span>
      </nav>

      <div className="ov-stats">
        <Stat href={to({ type: 'issue' })} value={o.totals.openIssues} label="Open issues" />
        <Stat href={to({ type: 'pr' })} value={o.totals.openPrs} label="Open PRs" />
        <Stat href={to({ ...WAITING, sort: 'created' })} value={o.totals.waiting} label="PRs waiting for first review" />
        <Stat href={to({ type: 'pr', who: 'community' })} value={o.totals.communityPrs} label="Community PRs open" />
        <Stat href={to({ staleFor: 30, sort: 'updated' })} value={o.totals.stale} label="Stale (>30 days)" />
      </div>

      <div className="ov-grid">
        <Section title="Issues opened vs closed">
          <WeekChart
            title="Per week"
            weeks={o.series}
            series={[
              { label: 'Opened', className: 'ov-s1', value: (w) => w.issuesOpened, href: opened('issue') },
              { label: 'Closed', className: 'ov-s2', value: (w) => w.issuesClosed, href: closed('issue') },
            ]}
          />
        </Section>
        <Section title="PRs opened vs closed/merged">
          <WeekChart
            title="Per week"
            weeks={o.series}
            series={[
              { label: 'Opened', className: 'ov-s1', value: (w) => w.prsOpened, href: opened('pr') },
              { label: 'Closed/merged', className: 'ov-s2', value: (w) => w.prsClosed, href: closed('pr') },
            ]}
          />
        </Section>

        <Section title="Time to first review" more={[to({ ...ALL, type: 'pr', created: since, firstReview: 'yes' }), `${o.review.reviewed} reviewed`]}>
          <div className="ov-stats">
            <Stat href={to({ ...ALL, type: 'pr', created: since, firstReview: 'yes' })} value={duration(o.review.median)} label="Median" />
            <Stat href={to({ ...ALL, type: 'pr', created: since, firstReview: 'yes' })} value={duration(o.review.p90)} label="p90" />
            <Stat href={to({ ...WAITING, created: since, sort: 'created' })} value={o.review.waiting} label="Still waiting" />
          </div>
          <WeekChart
            title="Median per week (by PR opened)"
            weeks={o.series}
            series={[
              {
                label: 'Median',
                className: 'ov-s1',
                value: (w) => w.reviewMedian,
                href: (w) => to({ ...ALL, type: 'pr', created: weekRange(w.start), firstReview: 'yes' }),
                format: duration,
              },
            ]}
          />
        </Section>

        <Section title="Open items per repository">
          <span className="ov-legend">
            <span>
              <i className="ov-s1" /> Issues
            </span>
            <span>
              <i className="ov-s2" /> PRs
            </span>
          </span>
          <ul className="ov-repos">
            {o.repos.map((r) => (
              <li key={r.repo}>
                <a href={to({ repo: r.repo })}>{r.repo}</a>
                <span className="ov-track">
                  {r.issues > 0 && (
                    <a className="ov-s1" href={to({ repo: r.repo, type: 'issue' })} style={{ width: `${(r.issues / maxRepo) * 100}%` }} title={`${r.issues} open issues`} aria-label={`${r.repo}: ${r.issues} open issues`} />
                  )}
                  {r.prs > 0 && (
                    <a className="ov-s2" href={to({ repo: r.repo, type: 'pr' })} style={{ width: `${(r.prs / maxRepo) * 100}%` }} title={`${r.prs} open PRs`} aria-label={`${r.repo}: ${r.prs} open PRs`} />
                  )}
                </span>
                <span className="count">{r.issues + r.prs}</span>
              </li>
            ))}
          </ul>
        </Section>

        <Section title="Most stale open items" more={[to({ staleFor: 30, sort: 'updated' }), 'All stale']}>
          <ItemList items={o.stale} link={(i) => to({ sort: 'updated', item: i.id })} date={(i) => i.updatedAt} />
        </Section>
        <Section title="Oldest PRs without review" more={[to({ ...WAITING, sort: 'created' }), `All ${o.totals.waiting}`]}>
          <ItemList items={o.unreviewed} link={(i) => to({ ...WAITING, sort: 'created', item: i.id })} date={(i) => i.createdAt} />
        </Section>

        <Section title={`New contributors (${o.newContributors.length})`} wide>
          {o.newContributors.length ? (
            <ul className="ov-people">
              {o.newContributors.map((c) => (
                <li key={c.author}>
                  <span>
                    <a href={to({ ...ALL, author: c.author })}>{c.author}</a>
                    {!isMember(c.first) && <span className="badge community">ext</span>}
                  </span>
                  <span className="count" title="Items in total">{c.count}</span>
                  <a href={to({ ...ALL, author: c.author, item: c.first.id })} title={c.first.title}>
                    <StateIcon item={c.first} /> {c.first.repo}#{c.first.number} {c.first.title}
                  </a>
                  <Time iso={c.first.createdAt} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No new contributors in this range.</p>
          )}
        </Section>
      </div>
      <p className="muted">Weeks start Monday (UTC). Stale means no update for 30 days. Drafts do not count as waiting for review.</p>
    </div>
  )
}

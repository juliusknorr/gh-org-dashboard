import { useEffect, useRef, useState, type SyntheticEvent } from 'react'
import type { Item, ItemAction, ItemDetails, MergeMethod, PrDetails, RepoOptions, Review } from '../../shared/types.ts'
import { mergeBlockers } from '../../shared/merge.ts'
import {
  AlertIcon,
  ClockIcon,
  CommentIcon,
  DuplicateIcon,
  EyeIcon,
  GitBranchIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  IssueClosedIcon,
  MilestoneIcon,
  PeopleIcon,
  PersonIcon,
  QuestionIcon,
  SkipIcon,
  TagIcon,
  XIcon,
  type Icon,
} from '@primer/octicons-react'
import { CiIcon, ReviewIcon, StateIcon, Time, textColor } from './format.tsx'
import { Picker, type PickerOption } from './Picker.tsx'

const SHORTCUTS = 'Shortcuts: j/k next/previous, o open on GitHub, c comment, l launch Claude, a assignees, Shift+L labels, Esc close'

const repoOptions = new Map<string, Promise<RepoOptions>>()
function loadRepoOptions(repo: string): Promise<RepoOptions> {
  if (!repoOptions.has(repo)) {
    const options = fetch(`/api/repos/${encodeURIComponent(repo)}/options`).then(async (res) => {
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error ?? `${res.status} ${res.statusText}`)
      return json as RepoOptions
    })
    options.catch(() => repoOptions.delete(repo))
    repoOptions.set(repo, options)
  }
  return repoOptions.get(repo)!
}

const users = (logins: string[]): PickerOption[] => logins.map((value) => ({ value }))

const FRAME_CSS = `
:root { color-scheme: light dark; --fg: #1f2328; --muted: #59636e; --border: #d1d9e0; --bg-alt: #f6f8fa; --accent: #0969da; }
@media (prefers-color-scheme: dark) { :root { --fg: #e6edf3; --muted: #9198a1; --border: #3d444d; --bg-alt: #151b23; --accent: #4493f8; } }
html { overflow: hidden; }
body { margin: 0; display: flow-root; font: 14px/1.5 system-ui, sans-serif; color: var(--fg); background: transparent; overflow-wrap: anywhere; }
a { color: var(--accent); }
img, video { max-width: 100%; height: auto; }
pre { overflow-x: auto; background: var(--bg-alt); padding: 0.5rem; border-radius: 6px; }
code { font: 12px ui-monospace, monospace; background: var(--bg-alt); padding: 0.1em 0.3em; border-radius: 4px; }
pre code { padding: 0; background: none; }
blockquote { margin: 0; padding-left: 0.75rem; border-left: 3px solid var(--border); color: var(--muted); }
table { border-collapse: collapse; } td, th { border: 1px solid var(--border); padding: 0.2rem 0.4rem; }
details summary { cursor: pointer; }
`

async function api(url: string, init?: RequestInit): Promise<ItemDetails> {
  const res = await fetch(url, init)
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error ?? `${res.status} ${res.statusText}`)
  return json
}

function HtmlFrame({ html, title }: { html: string; title: string }) {
  const observer = useRef<ResizeObserver>(null)
  useEffect(() => () => observer.current?.disconnect(), [])
  const onLoad = (e: SyntheticEvent<HTMLIFrameElement>) => {
    const frame = e.currentTarget
    const body = frame.contentDocument?.body
    if (!body) return
    observer.current?.disconnect()
    observer.current = new ResizeObserver(() => (frame.style.height = `${Math.ceil(body.getBoundingClientRect().height)}px`))
    observer.current.observe(body)
  }
  return (
    <iframe
      className="html"
      title={title}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={`<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>${FRAME_CSS}</style></head><body>${html || '<p style="color:var(--muted)"><em>No description provided.</em></p>'}</body></html>`}
      onLoad={onLoad}
    />
  )
}

const typeLabel = (i: Item) => (i.type === 'pr' ? (i.draft ? 'Draft PR' : 'PR') : 'Issue')

const latestReviews = (reviews: Review[]) =>
  [...new Map(reviews.toSorted((a, b) => (a.submittedAt ?? '').localeCompare(b.submittedAt ?? '')).map((r) => [r.author, r])).values()]

const Term = ({ icon: Glyph, children }: { icon: Icon; children: string }) => (
  <dt>
    <Glyph /> {children}
  </dt>
)

const None = () => <span className="muted">None</span>

function PrInfo({ pr }: { pr: PrDetails }) {
  return (
    <section>
      <h3>Pull request</h3>
      <p>
        <GitBranchIcon /> <code>{pr.headRef}</code> → <code>{pr.baseRef}</code>
      </p>
      <p>
        <span className="add">+{pr.additions}</span> <span className="del">−{pr.deletions}</span> · {pr.changedFiles} files · {pr.mergeable.toLowerCase()}
      </p>
      {pr.checks.length > 0 && (
        <ul className="checks">
          {pr.checks.map((c, i) => (
            <li key={i}>
              <CiIcon ci={c.conclusion ?? 'PENDING'} />{' '}
              {c.url ? (
                <a href={c.url} target="_blank" rel="noreferrer">
                  {c.name}
                </a>
              ) : (
                c.name
              )}
            </li>
          ))}
        </ul>
      )}
      {pr.reviews.length > 0 && (
        <ul className="reviews">
          {latestReviews(pr.reviews).map((r) => (
            <li key={r.author ?? ''}>
              <ReviewIcon state={r.state} /> {r.author ?? 'ghost'}{' '}
              {r.submittedAt && <Time iso={r.submittedAt} />}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function ForceMergeDialog({ details, onConfirm, onClose }: { details: ItemDetails; onConfirm: () => void; onClose: () => void }) {
  const ref = `${details.item.repo}#${details.item.number}`
  const [typed, setTyped] = useState('')
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => dialogRef.current?.showModal(), [])
  return (
    <dialog ref={dialogRef} className="launch" onClose={onClose}>
      <form method="dialog" onSubmit={() => typed === ref && onConfirm()}>
        <h2>Force merge {ref}?</h2>
        <p>These conditions are not met:</p>
        <ul>
          {mergeBlockers(details).soft.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
        <label>
          Type <code>{ref}</code> to confirm
          <input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" />
        </label>
        <div className="actions">
          <button type="button" onClick={() => dialogRef.current?.close()}>
            Cancel
          </button>
          <button type="submit" className="danger" disabled={typed !== ref}>
            <AlertIcon /> Force merge
          </button>
        </div>
      </form>
    </dialog>
  )
}

function Actions({ details, run }: { details: ItemDetails; run: (a: ItemAction) => Promise<void> }) {
  const { item, pr } = details
  const [comment, setComment] = useState('')
  const [duplicateOf, setDuplicateOf] = useState('')
  const [method, setMethod] = useState<MergeMethod | undefined>(pr?.defaultMergeMethod)
  const [forcing, setForcing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const body = comment.trim()
  const withComment = body ? { comment: body } : {}
  const closeLabel = body ? 'Comment and close' : 'Close'
  const submit = async (action: ItemAction) => {
    setBusy(true)
    setError(null)
    try {
      await run(action)
      if (action.type !== 'merge') setComment('')
      setDuplicateOf('')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const merge = (force: boolean) => pr && method && submit({ type: 'merge', method, expectedHeadOid: pr.headOid, force })
  const blockers = pr && mergeBlockers(details)
  const canClose = item.state === 'open' && details.viewerCanClose

  return (
    <section className="item-actions">
      <h3>Actions</h3>
      <label>
        Comment
        <textarea rows={4} value={comment} onChange={(e) => setComment(e.target.value)} data-shortcut="c" title="Comment (c)" />
      </label>
      <div className="row">
        <button type="button" disabled={busy || !body} onClick={() => submit({ type: 'comment', body })}>
          <CommentIcon /> Comment
        </button>
        {busy && <span className="muted">Working…</span>}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}

      {canClose && (
        <fieldset className="danger-zone">
          <legend>Close</legend>
          {item.type === 'issue' ? (
            <>
              <div className="row">
                <button type="button" disabled={busy} onClick={() => submit({ type: 'close', reason: 'COMPLETED', ...withComment })}>
                  <IssueClosedIcon className="state-merged" /> {closeLabel} as completed
                </button>
                <button type="button" disabled={busy} onClick={() => submit({ type: 'close', reason: 'NOT_PLANNED', ...withComment })}>
                  <SkipIcon /> {closeLabel} as not planned
                </button>
              </div>
              <div className="row">
                <label>
                  Duplicate of
                  <input value={duplicateOf} onChange={(e) => setDuplicateOf(e.target.value)} placeholder="#123, repo#123 or URL" />
                </label>
                <button type="button" disabled={busy || !duplicateOf.trim()} onClick={() => submit({ type: 'duplicate', of: duplicateOf.trim(), ...withComment })}>
                  <DuplicateIcon /> {closeLabel} as duplicate
                </button>
              </div>
            </>
          ) : (
            <div className="row">
              <button type="button" disabled={busy} onClick={() => submit({ type: 'close', reason: 'COMPLETED', ...withComment })}>
                <GitPullRequestClosedIcon className="state-closed" /> {closeLabel}
              </button>
            </div>
          )}
        </fieldset>
      )}

      {pr && blockers && (
        <fieldset className="danger-zone">
          <legend>Merge</legend>
          {blockers.hard.length + blockers.soft.length > 0 && (
            <ul className="blockers">
              {blockers.hard.map((b) => (
                <li key={b} className="error">{b}</li>
              ))}
              {blockers.soft.map((b) => (
                <li key={b} className="warn">{b}</li>
              ))}
            </ul>
          )}
          {!blockers.hard.length && (
            <>
              <div className="row">
                <label>
                  Method
                  <select value={method} onChange={(e) => setMethod(e.target.value as MergeMethod)}>
                    {pr.mergeMethods.map((m) => (
                      <option key={m} value={m}>
                        {m.toLowerCase()}
                      </option>
                    ))}
                  </select>
                </label>
                {blockers.soft.length ? (
                  <button type="button" className="danger" disabled={busy} onClick={() => setForcing(true)}>
                    <AlertIcon /> Force merge…
                  </button>
                ) : (
                  <button type="button" className="primary" disabled={busy} onClick={() => merge(false)}>
                    <GitMergeIcon /> Merge
                  </button>
                )}
              </div>
              {!pr.viewerCanMergeAsAdmin && <p className="muted">You are not an admin here, branch protection may still refuse the merge.</p>}
            </>
          )}
          {forcing && <ForceMergeDialog details={details} onConfirm={() => merge(true)} onClose={() => setForcing(false)} />}
        </fieldset>
      )}
    </section>
  )
}

export function Details({ id, listItem, onItem, onClose }: { id: string; listItem?: Item; onItem: (item: Item) => void; onClose: () => void }) {
  const [details, setDetails] = useState<ItemDetails | null>(null)
  const [error, setError] = useState<string | null>(null)
  const headingRef = useRef<HTMLHeadingElement>(null)
  const url = `/api/items/${encodeURIComponent(id)}`

  const loaded = (d: ItemDetails) => {
    setDetails(d)
    setError(null)
    onItem(d.item)
  }

  useEffect(() => headingRef.current?.focus(), [])
  useEffect(() => {
    const abort = new AbortController()
    api(url, { signal: abort.signal }).then(loaded, (e) => abort.signal.aborted || setError((e as Error).message))
    return () => abort.abort()
  }, [url])

  const run = async (action: ItemAction) =>
    loaded(await api(`${url}/actions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action) }))

  const item = details?.item ?? listItem
  return (
    <aside className="details" aria-label="Item details" aria-busy={!details}>
      <div className="details-head">
        <h2 ref={headingRef} tabIndex={-1}>
          {item ? (
            <a href={item.url} target="_blank" rel="noreferrer" data-shortcut="o" title="Open on GitHub (o)">
              {item.title}
            </a>
          ) : (
            'Loading…'
          )}
        </h2>
        <span className="hint" title={SHORTCUTS} aria-label={SHORTCUTS} role="img">
          <QuestionIcon />
        </span>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Close details" title="Close (Esc)">
          <XIcon />
        </button>
      </div>
      {item && (
        <>
          <p>
            <StateIcon item={item} /> {typeLabel(item)} · {item.repo}#{item.number}
          </p>
          <dl className="meta">
            <Term icon={PersonIcon}>Author</Term>
            <dd>{item.author ?? 'ghost'}</dd>
            <Term icon={ClockIcon}>Created</Term>
            <dd>
              <Time iso={item.createdAt} />
            </dd>
            <Term icon={ClockIcon}>Updated</Term>
            <dd>
              <Time iso={item.updatedAt} />
            </dd>
            <Picker
              icon={TagIcon}
              label="Labels"
              shortcut="L"
              selected={item.labels.map((l) => l.name)}
              load={async () => (await loadRepoOptions(item.repo)).labels.map((l) => ({ value: l.name, color: l.color, description: l.description }))}
              onApply={(add, remove) => run({ type: 'labels', add, remove })}
            >
              {item.labels.length ? (
                item.labels.map((l) => (
                  <span key={l.name} className="chip" style={{ background: `#${l.color}`, color: textColor(l.color) }}>
                    {l.name}
                  </span>
                ))
              ) : (
                <None />
              )}
            </Picker>
            <Picker
              icon={PeopleIcon}
              label="Assignees"
              shortcut="a"
              selected={item.assignees}
              load={async () => users((await loadRepoOptions(item.repo)).assignees)}
              onApply={(add, remove) => run({ type: 'assignees', add, remove })}
            >
              {item.assignees.join(', ') || <None />}
            </Picker>
            {item.type === 'pr' && (
              <Picker
                icon={EyeIcon}
                label="Review requests"
                selected={item.reviewRequests}
                load={async () => {
                  const { assignees, teams } = await loadRepoOptions(item.repo)
                  return users([...assignees.filter((a) => a !== item.author), ...teams.map((t) => `team:${t}`)])
                }}
                onApply={(add, remove) => run({ type: 'reviewers', add, remove })}
              >
                {item.reviewRequests.join(', ') || <None />}
              </Picker>
            )}
            {item.milestone && (
              <>
                <Term icon={MilestoneIcon}>Milestone</Term>
                <dd>{item.milestone}</dd>
              </>
            )}
          </dl>
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!details && !error && <p className="muted">Loading details…</p>}
      {details && (
        <>
          {details.pr && <PrInfo pr={details.pr} />}
          <HtmlFrame title="Description" html={details.bodyHTML} />
          <section>
            <h3>
              <CommentIcon /> Comments ({details.totalComments})
            </h3>
            {details.comments.length < details.totalComments && (
              <p className="muted">
                Showing last {details.comments.length} of {details.totalComments} comments
              </p>
            )}
            {details.comments.map((c) => (
              <article key={c.url} className="comment">
                <div className="comment-head">
                  <strong>{c.author ?? 'ghost'}</strong>{' '}
                  <a href={c.url} target="_blank" rel="noreferrer">
                    <Time iso={c.createdAt} />
                  </a>
                </div>
                <HtmlFrame title={`Comment by ${c.author ?? 'ghost'}`} html={c.bodyHTML} />
              </article>
            ))}
          </section>
          <Actions details={details} run={run} />
        </>
      )}
    </aside>
  )
}

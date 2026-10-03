import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type SyntheticEvent } from 'react'
import type { Item, ItemAction, ItemDetails, MergeMethod, PrDetails, RepoOptions, Review } from '../../shared/types.ts'
import { mergeBlockers } from '../../shared/merge.ts'
import {
  AlertIcon,
  ChecklistIcon,
  CommentIcon,
  DuplicateIcon,
  EyeIcon,
  GitBranchIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  IssueClosedIcon,
  MilestoneIcon,
  PeopleIcon,
  QuestionIcon,
  SkipIcon,
  TagIcon,
  TriangleDownIcon,
  XIcon,
  type Icon,
} from '@primer/octicons-react'
import { CiIcon, ReviewIcon, StateIcon, Time, textColor } from './format.tsx'
import { Picker, type PickerOption } from './Picker.tsx'

const WIDTH_KEY = 'details-width'
const MIN_WIDTH = 360
const DEFAULT_WIDTH = 480

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

const None = () => <span className="muted">None</span>

function storedWidth() {
  try {
    return Number(localStorage.getItem(WIDTH_KEY)) || DEFAULT_WIDTH
  } catch {
    return DEFAULT_WIDTH
  }
}

function applyWidth(width: number, persist: boolean) {
  const clamped = Math.round(Math.max(MIN_WIDTH, Math.min(width, innerWidth - 400)))
  document.documentElement.style.setProperty('--details-width', `${clamped}px`)
  if (!persist) return
  try {
    localStorage.setItem(WIDTH_KEY, String(clamped))
  } catch {}
}

function ResizeHandle() {
  useEffect(() => applyWidth(storedWidth(), false), [])
  const widthFromPointer = (e: PointerEvent) => innerWidth - e.clientX
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    document.body.classList.add('resizing')
  }
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => e.currentTarget.hasPointerCapture(e.pointerId) && applyWidth(widthFromPointer(e), false)
  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    document.body.classList.remove('resizing')
    applyWidth(widthFromPointer(e), true)
  }
  const onKeyDown = (e: KeyboardEvent) => {
    const step = { ArrowLeft: 32, ArrowRight: -32 }[e.key]
    if (!step) return
    e.preventDefault()
    applyWidth(storedWidth() + step, true)
  }
  return (
    <div
      className="resize-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize details (arrow keys)"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
      onDoubleClick={() => applyWidth(DEFAULT_WIDTH, true)}
    />
  )
}

function PrSummary({ pr }: { pr: PrDetails }) {
  return (
    <p className="byline">
      <GitBranchIcon /> <code>{pr.headRef}</code> → <code>{pr.baseRef}</code> · <span className="add">+{pr.additions}</span>{' '}
      <span className="del">−{pr.deletions}</span> · {pr.changedFiles} files
    </p>
  )
}

function Checks({ pr }: { pr: PrDetails }) {
  const reviews = latestReviews(pr.reviews)
  return (
    <>
      <section>
        <h3>Reviews</h3>
        {reviews.length ? (
          <ul className="reviews">
            {reviews.map((r) => (
              <li key={r.author ?? ''}>
                <ReviewIcon state={r.state} /> {r.author ?? 'ghost'} {r.submittedAt && <Time iso={r.submittedAt} />}
              </li>
            ))}
          </ul>
        ) : (
          <None />
        )}
      </section>
      <section>
        <h3>Checks</h3>
        {pr.checks.length ? (
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
        ) : (
          <None />
        )}
      </section>
      <p className="muted">Mergeable: {pr.mergeable.toLowerCase()}</p>
    </>
  )
}

function Conversation({ details }: { details: ItemDetails }) {
  const { item, comments, totalComments } = details
  return (
    <>
      <article className="comment">
        <div className="comment-head">
          <strong>{item.author ?? 'ghost'}</strong> opened <Time iso={item.createdAt} />
        </div>
        <HtmlFrame title="Description" html={details.bodyHTML} />
      </article>
      {comments.length < totalComments && (
        <p className="muted">
          Showing last {comments.length} of {totalComments} comments
        </p>
      )}
      {comments.map((c) => (
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
    </>
  )
}

async function renderMarkdown(text: string, repo: string): Promise<string> {
  const res = await fetch('/api/markdown', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, repo }) })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.error ?? `${res.status} ${res.statusText}`)
  return json.html
}

function Composer({ repo, value, onChange }: { repo: string; value: string; onChange: (v: string) => void }) {
  const [preview, setPreview] = useState<{ text: string; html?: string; error?: string } | null>(null)
  const showPreview = async () => {
    if (preview?.text === value) return
    setPreview({ text: value })
    try {
      setPreview({ text: value, html: value.trim() ? await renderMarkdown(value, repo) : '<p><em>Nothing to preview</em></p>' })
    } catch (e) {
      setPreview({ text: value, error: (e as Error).message })
    }
  }
  const [tab, setTab] = useState<'write' | 'preview'>('write')
  return (
    <div className="composer">
      <div className="dtabs small" role="tablist" aria-label="Comment">
        <button type="button" role="tab" aria-selected={tab === 'write'} onClick={() => setTab('write')}>
          Write
        </button>
        <button type="button" role="tab" aria-selected={tab === 'preview'} onClick={() => (setTab('preview'), showPreview())}>
          Preview
        </button>
      </div>
      {tab === 'write' ? (
        <textarea
          rows={3}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Leave a comment (Markdown)"
          aria-label="Comment"
          data-shortcut="c"
          title="Comment (c)"
          onFocus={() => setTab('write')}
        />
      ) : (
        <div className="composer-preview">
          {preview?.error ? <p className="error">{preview.error}</p> : preview?.html !== undefined ? <HtmlFrame title="Comment preview" html={preview.html} /> : <p className="muted">Rendering…</p>}
        </div>
      )}
    </div>
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

function Footer({ details, run }: { details: ItemDetails; run: (a: ItemAction) => Promise<void> }) {
  const { item, pr } = details
  const [comment, setComment] = useState('')
  const [duplicateOf, setDuplicateOf] = useState('')
  const [method, setMethod] = useState<MergeMethod | undefined>(pr?.defaultMergeMethod)
  const [forcing, setForcing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const menuRef = useRef<HTMLDetailsElement>(null)
  const body = comment.trim()
  const withComment = body ? { comment: body } : {}
  const closeLabel = body ? 'Comment and close' : 'Close'
  const submit = async (action: ItemAction) => {
    if (menuRef.current) menuRef.current.open = false
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
  const blockers = pr && item.state === 'open' ? mergeBlockers(details) : null
  const canClose = item.state === 'open' && details.viewerCanClose

  return (
    <footer className="details-foot">
      <Composer repo={item.repo} value={comment} onChange={setComment} />
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {blockers && blockers.hard.length + blockers.soft.length > 0 && (
        <p className={blockers.hard.length ? 'error' : 'warn'}>
          <AlertIcon /> {[...blockers.hard, ...blockers.soft].join(' · ')}
        </p>
      )}
      <div className="row">
        <button type="button" disabled={busy || !body} onClick={() => submit({ type: 'comment', body })}>
          <CommentIcon /> Comment
        </button>
        {canClose && (
          <details className="menu" ref={menuRef}>
            <summary className="button">
              {item.type === 'issue' ? <IssueClosedIcon /> : <GitPullRequestClosedIcon />} {closeLabel} <TriangleDownIcon />
            </summary>
            <div className="menu-body">
              {item.type === 'issue' ? (
                <>
                  <button type="button" disabled={busy} onClick={() => submit({ type: 'close', reason: 'COMPLETED', ...withComment })}>
                    <IssueClosedIcon className="state-merged" /> as completed
                  </button>
                  <button type="button" disabled={busy} onClick={() => submit({ type: 'close', reason: 'NOT_PLANNED', ...withComment })}>
                    <SkipIcon /> as not planned
                  </button>
                  <form className="row" onSubmit={(e) => (e.preventDefault(), submit({ type: 'duplicate', of: duplicateOf.trim(), ...withComment }))}>
                    <input value={duplicateOf} onChange={(e) => setDuplicateOf(e.target.value)} placeholder="#123, repo#123 or URL" aria-label="Duplicate of" />
                    <button type="submit" disabled={busy || !duplicateOf.trim()}>
                      <DuplicateIcon /> as duplicate
                    </button>
                  </form>
                </>
              ) : (
                <button type="button" disabled={busy} onClick={() => submit({ type: 'close', reason: 'COMPLETED', ...withComment })}>
                  <GitPullRequestClosedIcon className="state-closed" /> Close pull request
                </button>
              )}
            </div>
          </details>
        )}
        {pr && blockers && !blockers.hard.length && (
          <span className="merge">
            <select value={method} onChange={(e) => setMethod(e.target.value as MergeMethod)} aria-label="Merge method">
              {pr.mergeMethods.map((m) => (
                <option key={m} value={m}>
                  {m.toLowerCase()}
                </option>
              ))}
            </select>
            {blockers.soft.length ? (
              <button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => setForcing(true)}
                title={pr.viewerCanMergeAsAdmin ? undefined : 'You are not an admin here, branch protection may still refuse the merge'}
              >
                <AlertIcon /> Force merge…
              </button>
            ) : (
              <button type="button" className="primary" disabled={busy} onClick={() => merge(false)}>
                <GitMergeIcon /> Merge
              </button>
            )}
          </span>
        )}
        {busy && <span className="muted">Working…</span>}
      </div>
      {forcing && <ForceMergeDialog details={details} onConfirm={() => merge(true)} onClose={() => setForcing(false)} />}
    </footer>
  )
}

export function Details({ id, listItem, onItem, onClose }: { id: string; listItem?: Item; onItem: (item: Item) => void; onClose: () => void }) {
  const [details, setDetails] = useState<ItemDetails | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'conversation' | 'checks'>('conversation')
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
  const pr = details?.pr
  return (
    <aside className="details" aria-label="Item details" aria-busy={!details}>
      <ResizeHandle />
      <header className="details-head">
        <div className="details-top">
          {item && <StateIcon item={item} />}
          {item && (
            <span className="muted">
              {typeLabel(item)} · {item.repo}#{item.number}
            </span>
          )}
          <span className="hint" title={SHORTCUTS} aria-label={SHORTCUTS} role="img">
            <QuestionIcon />
          </span>
          <button type="button" className="icon-button" onClick={onClose} aria-label="Close details" title="Close (Esc)">
            <XIcon />
          </button>
        </div>
        <h2 ref={headingRef} tabIndex={-1}>
          {item ? (
            <a href={item.url} target="_blank" rel="noreferrer" data-shortcut="o" title="Open on GitHub (o)">
              {item.title}
            </a>
          ) : (
            'Loading…'
          )}
        </h2>
        {item && (
          <p className="byline">
            {item.author ?? 'ghost'} opened <Time iso={item.createdAt} /> · updated <Time iso={item.updatedAt} />
            {item.milestone && (
              <>
                {' '}
                · <MilestoneIcon /> {item.milestone}
              </>
            )}
          </p>
        )}
        {pr && <PrSummary pr={pr} />}
        {item && (
          <dl className="meta">
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
                label="Reviewers"
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
          </dl>
        )}
      </header>
      {pr && (
        <div className="dtabs" role="tablist" aria-label="Details">
          <button type="button" role="tab" aria-selected={tab === 'conversation'} onClick={() => setTab('conversation')}>
            <CommentIcon /> Conversation <span className="count">{details.totalComments}</span>
          </button>
          <button type="button" role="tab" aria-selected={tab === 'checks'} onClick={() => setTab('checks')}>
            <ChecklistIcon /> Checks & reviews <span className="count">{pr.checks.length}</span>
          </button>
        </div>
      )}
      <div className="details-body" role={pr ? 'tabpanel' : undefined}>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {!details && !error && <p className="muted">Loading details…</p>}
        {details && (pr && tab === 'checks' ? <Checks pr={pr} /> : <Conversation details={details} />)}
      </div>
      {details && <Footer details={details} run={run} />}
    </aside>
  )
}

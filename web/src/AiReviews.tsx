import { useCallback, useEffect, useRef, useState } from 'react'
import { AgentIcon, PlayIcon, SyncIcon, TrashIcon } from '@primer/octicons-react'
import type { AiReviewSummary, Item } from '../../shared/types.ts'
import { StateIcon, Time, itemRef } from './format.tsx'

const RUNNING_POLL_MS = 3000
const IDLE_POLL_MS = 30_000
const CHANGED = 'ai-reviews-changed'

export const notifyReviewsChanged = () => dispatchEvent(new Event(CHANGED))

export function useAiReviews() {
  const [reviews, setReviews] = useState<AiReviewSummary[]>([])
  const [error, setError] = useState<string | null>(null)
  const last = useRef('')
  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/reviews')
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      const text = await res.text()
      if (text !== last.current) setReviews(JSON.parse(text))
      last.current = text
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])
  const anyRunning = reviews.some((r) => r.status === 'running')
  useEffect(() => {
    void load()
    addEventListener(CHANGED, load)
    const timer = setInterval(load, anyRunning ? RUNNING_POLL_MS : IDLE_POLL_MS)
    return () => {
      removeEventListener(CHANGED, load)
      clearInterval(timer)
    }
  }, [load, anyRunning])
  return { reviews, error, setReviews, setError }
}

export const AI_STATUS_LABELS: Record<AiReviewSummary['status'], string> = { running: 'AI review running', done: 'AI review ready', failed: 'AI review failed' }

export function AiStatusIcon({ status }: { status?: AiReviewSummary['status'] }) {
  if (status === 'running') return <SyncIcon className="spin" />
  return <AgentIcon className={status === 'failed' ? 'state-closed' : status === 'done' ? 'state-open' : undefined} />
}

export async function startAiReview(id: string) {
  await post(`/api/items/${encodeURIComponent(id)}/review`, {})
  notifyReviewsChanged()
}

async function post(url: string, body: unknown) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(json.dirs ? `${json.error}, open the pull request to pick one` : (json.error ?? `${res.status} ${res.statusText}`))
  return json
}

function Suggestions({ items, viewer, reviewed }: { items: Item[]; viewer: string | null; reviewed: Set<string> }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (!viewer) return null
  const pending = items
    .filter((i) => i.type === 'pr' && i.state === 'open' && !i.draft && i.reviewRequests.includes(viewer) && !reviewed.has(i.id))
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const start = async (id: string) => {
    setBusy(id)
    setError(null)
    try {
      await startAiReview(id)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  return (
    <>
      <h2>Waiting for your review</h2>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!pending.length ? (
        <p className="muted">No open pull requests request your review without an AI review.</p>
      ) : (
        <table className="ov-table">
          <thead>
            <tr>
              <th>Pull request</th>
              <th>Author</th>
              <th>Updated</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {pending.map((i) => (
              <tr key={i.id}>
                <td>
                  <StateIcon item={i} /> <a href={`/?item=${encodeURIComponent(i.id)}#ai`}>{`${itemRef(i)} ${i.title}`}</a>
                </td>
                <td>{i.author ?? 'ghost'}</td>
                <td>
                  <Time iso={i.updatedAt} />
                </td>
                <td>
                  <button type="button" disabled={busy !== null} onClick={() => start(i.id)}>
                    <PlayIcon /> {busy === i.id ? 'Starting…' : 'Run AI review'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

export function AiReviews({ items, viewer }: { items: Item[]; viewer: string | null }) {
  const { reviews, error, setReviews, setError } = useAiReviews()
  const [busy, setBusy] = useState<string | null>(null)
  const prune = async (id: string) => {
    setBusy(id)
    try {
      setReviews(await post('/api/reviews/prune', { id }))
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const sorted = reviews.toSorted((a, b) => Number(b.status === 'running') - Number(a.status === 'running') || (b.lastAt ?? '').localeCompare(a.lastAt ?? ''))
  return (
    <div className="settings">
      <h2>AI reviews</h2>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!sorted.length ? (
        <p className="muted">No AI reviews yet. Start one from the "AI review" tab of a pull request.</p>
      ) : (
        <table className="ov-table">
          <thead>
            <tr>
              <th>Status</th>
              <th>Pull request</th>
              <th>Turns</th>
              <th>Last result</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.id}>
                <td title={r.error ?? undefined}>
                  <AiStatusIcon status={r.status} /> {r.status === 'running' ? (r.pending === 'question' ? 'answering' : 'reviewing') : r.status}
                </td>
                <td>
                  {r.item && <StateIcon item={r.item} />} <a href={`/?item=${encodeURIComponent(r.id)}#ai`}>{r.item ? `${itemRef(r.item)} ${r.item.title}` : r.id}</a>
                </td>
                <td>{r.turns}</td>
                <td>{r.lastAt ? <Time iso={r.lastAt} /> : <span className="muted">none</span>}</td>
                <td>
                  <button
                    type="button"
                    disabled={r.status === 'running' || busy === r.id}
                    onClick={() => prune(r.id)}
                    title={r.worktree ? 'Delete the review and remove its worktree' : 'Delete the review'}
                  >
                    <TrashIcon /> Prune
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Suggestions items={items} viewer={viewer} reviewed={new Set(reviews.map((r) => r.id))} />
    </div>
  )
}

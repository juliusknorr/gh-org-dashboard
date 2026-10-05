import { useEffect, useState } from 'react'
import { PlusIcon, TrashIcon } from '@primer/octicons-react'

type Row = { name: string; sources: string }

const toRows = (presets: Record<string, string[]>): Row[] => Object.entries(presets).map(([name, sources]) => ({ name, sources: sources.join('\n') }))

const lines = (text: string) => [...new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))]

export function Settings({ onSaved }: { onSaved: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [status, setStatus] = useState<{ error?: string; message?: string }>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch('/api/presets')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`${res.status} ${res.statusText}`))))
      .then((presets) => setRows(toRows(presets)), (err) => setStatus({ error: String(err) }))
  }, [])

  if (!rows) return <div className="settings">{status.error ? <p className="error">{status.error}</p> : <p className="muted">Loading…</p>}</div>

  const change = (i: number, patch: Partial<Row>) => setRows(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  const names = rows.map((r) => r.name.trim())
  const duplicate = names.find((n, i) => n && names.indexOf(n) !== i)

  const save = async () => {
    setBusy(true)
    setStatus({})
    try {
      const body = Object.fromEntries(rows.map((r) => [r.name.trim(), lines(r.sources)]))
      const res = await fetch('/api/presets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error ?? `${res.status} ${res.statusText}`)
      setRows(toRows(json))
      setStatus({ message: 'Saved. New repositories are synced in the background.' })
      onSaved()
    } catch (err) {
      setStatus({ error: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings">
      <h2>Presets</h2>
      <p className="muted">Each preset is a team view. Add one GitHub org or owner/repo per line.</p>
      {rows.map((row, i) => (
        <fieldset key={i} className="ov-card">
          <label>
            Name
            <input value={row.name} onChange={(e) => change(i, { name: e.target.value })} placeholder="office" />
          </label>
          <label>
            Orgs and repositories
            <textarea
              rows={Math.max(3, row.sources.split('\n').length + 1)}
              value={row.sources}
              onChange={(e) => change(i, { sources: e.target.value })}
              placeholder={'Euro-Office\nnextcloud/richdocuments'}
              spellCheck={false}
            />
          </label>
          <button type="button" onClick={() => setRows(rows.filter((_, j) => j !== i))} disabled={rows.length === 1}>
            <TrashIcon /> Remove preset
          </button>
        </fieldset>
      ))}
      <div className="row">
        <button type="button" onClick={() => setRows([...rows, { name: '', sources: '' }])}>
          <PlusIcon /> Add preset
        </button>
        <button type="button" className="primary" onClick={save} disabled={busy || !!duplicate || names.some((n) => !n)}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        {duplicate && <span className="error">Preset names must be unique, "{duplicate}" is used twice.</span>}
        {status.error && <span className="error" role="alert">{status.error}</span>}
        {status.message && <span className="muted" role="status">{status.message}</span>}
      </div>
    </div>
  )
}

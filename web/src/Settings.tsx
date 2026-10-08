import { useEffect, useState } from 'react'
import { AGENTS, TERMINALS, type Settings as LaunchSettings } from '../../shared/types.ts'
import { PlusIcon, TrashIcon } from '@primer/octicons-react'

type Row = { name: string; sources: string }

const EMPTY_ROW: Row = { name: '', sources: '' }
const TERMINAL_LABELS: Record<LaunchSettings['terminal'], string> = { iterm: 'iTerm', cmux: 'cmux' }
const AGENT_LABELS: Record<LaunchSettings['agent'], string> = { claude: 'Claude Code', custom: 'Custom command' }

const toRows = (presets: Record<string, string[]>): Row[] => {
  const rows = Object.entries(presets).map(([name, sources]) => ({ name, sources: sources.join('\n') }))
  return rows.length ? rows : [EMPTY_ROW]
}

const lines = (text: string) => [...new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))]

export function Settings({ onSaved }: { onSaved: () => void }) {
  return (
    <div className="settings">
      <Presets onSaved={onSaved} />
      <LaunchForm onSaved={onSaved} />
      <Folders />
    </div>
  )
}

type Folder = { name: string; path: string; files: string }

function Folders() {
  const [folders, setFolders] = useState<Folder[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/folders')
      .then((res) => res.json())
      .then(setFolders, (err) => setError(String(err)))
  }, [])

  const open = async (name: string) => {
    const res = await fetch('/api/folders/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) })
    setError(res.ok ? '' : (await res.json().catch(() => ({}))).error ?? `${res.status} ${res.statusText}`)
  }

  return (
    <>
      <h2>Files</h2>
      {folders.map((f) => (
        <p key={f.name}>
          {f.name}:{' '}
          <button type="button" className="link folder-link" onClick={() => open(f.name)} title="Open in Finder">
            {f.path}
          </button>{' '}
          <span className="muted">{f.files}</span>
        </p>
      ))}
      {error && <p className="error" role="alert">{error}</p>}
    </>
  )
}

function Presets({ onSaved }: { onSaved: () => void }) {
  const [rows, setRows] = useState<Row[] | null>(null)
  const [status, setStatus] = useState<{ error?: string; message?: string }>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch('/api/presets')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`${res.status} ${res.statusText}`))))
      .then((presets) => setRows(toRows(presets)), (err) => setStatus({ error: String(err) }))
  }, [])

  if (!rows) return status.error ? <p className="error">{status.error}</p> : <p className="muted">Loading…</p>

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
    <>
      <h2>Presets</h2>
      <p className="muted">Each preset is a team view. Add one GitHub org or owner/repo per line.</p>
      {rows.map((row, i) => (
        <fieldset key={i} className="ov-card">
          <label>
            Name
            <input value={row.name} onChange={(e) => change(i, { name: e.target.value })} placeholder="my-team" />
          </label>
          <label>
            Orgs and repositories
            <textarea
              rows={Math.max(3, row.sources.split('\n').length + 1)}
              value={row.sources}
              onChange={(e) => change(i, { sources: e.target.value })}
              placeholder={'my-org\nother-org/some-repo'}
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
    </>
  )
}

function LaunchForm({ onSaved }: { onSaved: () => void }) {
  const [settings, setSettings] = useState<LaunchSettings | null>(null)
  const [status, setStatus] = useState<{ error?: string; message?: string }>({})
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch('/api/settings')
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`${res.status} ${res.statusText}`))))
      .then(setSettings, (err) => setStatus({ error: String(err) }))
  }, [])

  if (!settings) return status.error ? <p className="error">{status.error}</p> : null

  const change = (patch: Partial<LaunchSettings>) => setSettings({ ...settings, ...patch })
  const save = async () => {
    setBusy(true)
    setStatus({})
    try {
      const res = await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings) })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json.error ?? `${res.status} ${res.statusText}`)
      setSettings(json)
      setStatus({ message: 'Saved.' })
      onSaved()
    } catch (err) {
      setStatus({ error: (err as Error).message })
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h2>Coding agent</h2>
      <fieldset className="ov-card">
        <label>
          Terminal
          <select value={settings.terminal} onChange={(e) => change({ terminal: e.target.value as LaunchSettings['terminal'] })}>
            {TERMINALS.map((t) => (
              <option key={t} value={t}>
                {TERMINAL_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Agent
          <select value={settings.agent} onChange={(e) => change({ agent: e.target.value as LaunchSettings['agent'] })}>
            {AGENTS.map((a) => (
              <option key={a} value={a}>
                {AGENT_LABELS[a]}
              </option>
            ))}
          </select>
        </label>
        {settings.agent === 'custom' && (
          <label>
            Agent command
            <input value={settings.agentCommand} onChange={(e) => change({ agentCommand: e.target.value })} placeholder="codex {prompt}" spellCheck={false} />
            <span className="muted">Runs in the checkout. {'{prompt}'} and {'{name}'} are replaced, already shell-quoted.</span>
          </label>
        )}
        {settings.agent === 'custom' && (
          <label>
            Background review command
            <input value={settings.reviewCommand} onChange={(e) => change({ reviewCommand: e.target.value })} placeholder="codex exec --sandbox read-only {prompt}" spellCheck={false} />
            <span className="muted">Used for "AI review", its output is the review. Make it read-only: the agent reads untrusted PR content without supervision.</span>
          </label>
        )}
        <label>
          Repository folder
          <input value={settings.reposDir} onChange={(e) => change({ reposDir: e.target.value })} placeholder="~/repos" spellCheck={false} />
          <span className="muted">Existing checkouts are found up to four levels deep, including nested repositories and submodules. Missing ones are cloned with gh.</span>
        </label>
        <label>
          Superproject (optional)
          <input value={settings.superproject} onChange={(e) => change({ superproject: e.target.value })} placeholder="main-repo" spellCheck={false} />
          <span className="muted">A repository in that folder whose git submodules are used instead of separate checkouts.</span>
        </label>
        <label>
          Review prompt
          <textarea rows={3} value={settings.reviewPrompt} onChange={(e) => change({ reviewPrompt: e.target.value })} />
          <span className="muted">Used for "Review PR". {'{url}'} is replaced with the pull request URL.</span>
        </label>
      </fieldset>
      <div className="row">
        <button type="button" className="primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        {status.error && <span className="error" role="alert">{status.error}</span>}
        {status.message && <span className="muted" role="status">{status.message}</span>}
      </div>
    </>
  )
}

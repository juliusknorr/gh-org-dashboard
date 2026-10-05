import { useEffect, useRef, useState } from 'react'
import { CopyIcon, TerminalIcon } from '@primer/octicons-react'
import type { Item, LaunchRequest, LaunchResponse } from '../../shared/types.ts'
import { itemRef } from './format.tsx'

type Preset = { id: string; label: string; for: Item['type'][]; prompt: (item: Item) => string }

const PRESETS: Preset[] = [
  { id: 'review', label: 'Review PR', for: ['pr'], prompt: (i) => `/julius-review ${i.url}` },
  {
    id: 'work',
    label: 'Work on issue',
    for: ['issue'],
    prompt: (i) =>
      `Work on GitHub issue ${i.url}. Read the issue and its comments with gh, ask me when the scope is unclear, and propose a plan before changing code.`,
  },
  {
    id: 'advisory',
    label: 'Investigate advisory',
    for: ['advisory'],
    prompt: (i) =>
      `Investigate security advisory ${i.url}. Read it with gh api, locate the affected code, assess the impact and propose a fix. Do not push, comment or publish anything.`,
  },
  { id: 'free', label: 'Free prompt', for: ['issue', 'pr', 'advisory'], prompt: (i) => i.url },
]

async function postLaunch(body: LaunchRequest): Promise<LaunchResponse> {
  const res = await fetch('/api/launch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error ?? `${res.status} ${res.statusText}`)
  return json
}

export function LaunchDialog({ item, onClose }: { item: Item; onClose: () => void }) {
  const presets = PRESETS.filter((p) => p.for.includes(item.type))
  const [presetId, setPresetId] = useState(presets[0].id)
  const [prompt, setPrompt] = useState(() => presets[0].prompt(item))
  const [extra, setExtra] = useState('')
  const [worktree, setWorktree] = useState(true)
  const [remoteControl, setRemoteControl] = useState(false)
  const [status, setStatus] = useState<{ busy?: boolean; message?: string; error?: string }>({})
  const dialogRef = useRef<HTMLDialogElement>(null)

  useEffect(() => dialogRef.current?.showModal(), [])

  const choosePreset = (preset: Preset) => {
    setPresetId(preset.id)
    setPrompt(preset.prompt(item))
  }

  const submit = async (dryRun: boolean) => {
    setStatus({ busy: true })
    try {
      const fullPrompt = [prompt.trim(), extra.trim()].filter(Boolean).join('\n\n')
      const result = await postLaunch({ id: item.id, prompt: fullPrompt, worktree, remoteControl, dryRun })
      if (dryRun) await navigator.clipboard.writeText(result.command)
      setStatus({ message: dryRun ? 'Command copied to clipboard' : `Launched in ${result.dir}` })
    } catch (e) {
      setStatus({ error: (e as Error).message })
    }
  }

  return (
    <dialog ref={dialogRef} className="launch" onClose={onClose}>
      <form method="dialog" onSubmit={(e) => (e.preventDefault(), submit(false))}>
        <h2>Launch Claude Code</h2>
        <p className="muted">
          {itemRef(item)} {item.title}
        </p>
        <fieldset className="presets">
          <legend>Action</legend>
          {presets.map((p) => (
            <label key={p.id}>
              <input type="radio" name="preset" checked={presetId === p.id} onChange={() => choosePreset(p)} />
              {p.label}
            </label>
          ))}
        </fieldset>
        <label>
          Prompt
          <textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} required />
        </label>
        <label>
          Extra instructions
          <textarea rows={3} value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="e.g. focus on the docker changes" autoFocus />
        </label>
        <div className="options">
          <label>
            <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} /> Separate worktree
          </label>
          <label>
            <input type="checkbox" checked={remoteControl} onChange={(e) => setRemoteControl(e.target.checked)} /> Remote Control
          </label>
        </div>
        {status.message && <p role="status">{status.message}</p>}
        {status.error && <p className="error" role="alert">{status.error}</p>}
        <div className="actions">
          <button type="button" onClick={() => dialogRef.current?.close()}>
            Close
          </button>
          <button type="button" onClick={() => submit(true)} disabled={status.busy}>
            <CopyIcon /> Copy command
          </button>
          <button type="submit" className="primary" disabled={status.busy}>
            <TerminalIcon /> Launch in terminal
          </button>
        </div>
      </form>
    </dialog>
  )
}

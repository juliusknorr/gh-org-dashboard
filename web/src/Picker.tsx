import { useId, useRef, useState, type ReactNode, type SyntheticEvent } from 'react'
import { GearIcon, type Icon } from '@primer/octicons-react'

export type PickerOption = { value: string; color?: string; description?: string | null }

type Props = {
  icon: Icon
  label: string
  shortcut?: string
  selected: string[]
  load: () => Promise<PickerOption[]>
  onApply: (add: string[], remove: string[]) => Promise<void>
  children: ReactNode
}

export function Picker({ icon: Glyph, label, shortcut, selected, load, onApply, children }: Props) {
  const id = useId()
  const buttonRef = useRef<HTMLButtonElement>(null)
  const filterRef = useRef<HTMLInputElement>(null)
  const [options, setOptions] = useState<PickerOption[] | null>(null)
  const [checked, setChecked] = useState<string[]>([])
  const [initial, setInitial] = useState<string[]>([])
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const opened = (popover: HTMLElement) => {
    const rect = buttonRef.current!.getBoundingClientRect()
    popover.style.top = `${rect.bottom + 4}px`
    popover.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - popover.offsetWidth - 8))}px`
    setChecked(selected)
    setInitial(selected)
    setFilter('')
    setError(null)
    filterRef.current?.focus()
    if (!options) load().then(setOptions, (e: Error) => setError(e.message))
  }

  const closed = async () => {
    const add = checked.filter((v) => !initial.includes(v))
    const remove = initial.filter((v) => !checked.includes(v))
    if (!add.length && !remove.length) return
    setBusy(true)
    try {
      await onApply(add, remove)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const onToggle = (e: SyntheticEvent<HTMLDivElement>) =>
    (e.nativeEvent as ToggleEvent).newState === 'open' ? opened(e.currentTarget) : closed()

  const known = new Set(options?.map((o) => o.value))
  const all: PickerOption[] = [...initial.filter((v) => !known.has(v)).map((value) => ({ value })), ...(options ?? [])]
  const needle = filter.trim().toLowerCase()
  const visible = all
    .filter((o) => o.value.toLowerCase().includes(needle))
    .toSorted((a, b) => Number(initial.includes(b.value)) - Number(initial.includes(a.value)))
  const title = `Edit ${label.toLowerCase()}${shortcut ? ` (${shortcut})` : ''}`

  return (
    <>
      <dt>
        <Glyph /> {label}
        <button ref={buttonRef} type="button" className="icon-button" popoverTarget={id} disabled={busy} data-shortcut={shortcut} title={title} aria-label={title}>
          <GearIcon />
        </button>
      </dt>
      <dd>
        {children}
        {busy && <span className="muted">Saving…</span>}
        {error && (
          <span className="error" role="alert">
            {error}
          </span>
        )}
      </dd>
      <div id={id} popover="auto" className="picker" onToggle={onToggle} aria-label={title}>
        <input ref={filterRef} placeholder={`Filter ${label.toLowerCase()}`} value={filter} onChange={(e) => setFilter(e.target.value)} />
        {!options && !error && <p className="muted">Loading…</p>}
        <fieldset>
          <legend className="sr-only">{label}</legend>
          {visible.map((o) => (
            <label key={o.value} className="check" title={o.description ?? undefined}>
              <input
                type="checkbox"
                checked={checked.includes(o.value)}
                onChange={(e) => setChecked((c) => (e.target.checked ? [...c, o.value] : c.filter((v) => v !== o.value)))}
              />
              {o.color && <i className="dot" style={{ background: `#${o.color}` }} />}
              <span>{o.value}</span>
            </label>
          ))}
        </fieldset>
      </div>
    </>
  )
}

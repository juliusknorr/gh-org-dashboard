import { useEffect, useRef } from 'react'

type Context = 'list' | 'item'

const SHORTCUTS: { keys: string[]; label: string; context: Context; hint?: string }[] = [
  { keys: ['j', 'k'], label: 'Next / previous item', context: 'list', hint: 'move' },
  { keys: ['?'], label: 'Show all shortcuts', context: 'list' },
  { keys: ['e'], label: 'Mark read / unread', context: 'item', hint: 'read' },
  { keys: ['o'], label: 'Open on GitHub', context: 'item', hint: 'open' },
  { keys: ['c'], label: 'Comment', context: 'item', hint: 'comment' },
  { keys: ['r'], label: 'Review pull request', context: 'item', hint: 'review' },
  { keys: ['l'], label: 'Launch coding agent', context: 'item', hint: 'agent' },
  { keys: ['a'], label: 'Edit assignees', context: 'item' },
  { keys: ['Shift', 'L'], label: 'Edit labels', context: 'item' },
  { keys: ['Esc'], label: 'Close details', context: 'item', hint: 'close' },
]

const GROUPS: [Context, string][] = [
  ['list', 'Item list'],
  ['item', 'With an item open'],
]

const Keys = ({ keys }: { keys: string[] }) => (
  <span className="keys">
    {keys.map((k) => (
      <kbd key={k}>{k}</kbd>
    ))}
  </span>
)

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  useEffect(() => dialogRef.current?.showModal(), [])
  return (
    <dialog ref={dialogRef} className="launch shortcuts" onClose={onClose} onClick={(e) => e.target === e.currentTarget && dialogRef.current?.close()}>
      <form method="dialog">
        <h2>Keyboard shortcuts</h2>
        {GROUPS.map(([context, title]) => (
          <section key={context}>
            <h3>{title}</h3>
            <dl>
              {SHORTCUTS.filter((s) => s.context === context).map((s) => (
                <div key={s.label}>
                  <dt>
                    <Keys keys={s.keys} />
                  </dt>
                  <dd>{s.label}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
        <div className="actions">
          <button type="submit">Close</button>
        </div>
      </form>
    </dialog>
  )
}

export function ShortcutHints({ context, onHelp }: { context: Context; onHelp: () => void }) {
  const hints = SHORTCUTS.filter((s) => s.hint && (context === 'item' || s.context === 'list'))
  return (
    <div className="shortcut-hints" role="note" aria-label="Keyboard shortcuts">
      {hints.map((s) => (
        <span key={s.label} title={s.label}>
          <Keys keys={s.keys} /> {s.hint}
        </span>
      ))}
      <button type="button" className="link" onClick={onHelp}>
        <kbd>?</kbd> all shortcuts
      </button>
    </div>
  )
}

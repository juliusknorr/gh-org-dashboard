import {
  CheckIcon,
  DotFillIcon,
  EyeIcon,
  FileDiffIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  IssueClosedIcon,
  IssueOpenedIcon,
  XIcon,
  VerifiedIcon,
  type Icon,
} from '@primer/octicons-react'
import type { CiState, Item, ReviewDecision } from '../../shared/types.ts'
import { authorKind } from './filters.ts'

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31_536_000],
  ['month', 2_592_000],
  ['week', 604_800],
  ['day', 86_400],
  ['hour', 3_600],
  ['minute', 60],
]
function timeAgo(iso: string) {
  const seconds = (Date.parse(iso) - Date.now()) / 1000
  const [unit, size] = UNITS.find(([, size]) => Math.abs(seconds) >= size) ?? ['second', 1]
  return relative.format(Math.round(seconds / size), unit)
}
export const Time = ({ iso }: { iso: string }) => (
  <time dateTime={iso} title={new Date(iso).toLocaleString()}>
    {timeAgo(iso)}
  </time>
)

export function textColor(hex: string) {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16))
  return r * 0.299 + g * 0.587 + b * 0.114 > 150 ? '#000' : '#fff'
}

const Labeled = ({ icon: Glyph, label, className }: { icon: Icon; label: string; className: string }) => (
  <span className={`icon ${className}`} title={label}>
    <Glyph aria-label={label} />
  </span>
)

function stateIcon({ type, state, draft }: Item): [Icon, string, string] {
  if (type === 'issue') return state === 'open' ? [IssueOpenedIcon, 'Open issue', 'state-open'] : [IssueClosedIcon, 'Closed issue', 'state-merged']
  if (state === 'merged') return [GitMergeIcon, 'Merged pull request', 'state-merged']
  if (state === 'closed') return [GitPullRequestClosedIcon, 'Closed pull request', 'state-closed']
  return draft ? [GitPullRequestDraftIcon, 'Draft pull request', 'state-draft'] : [GitPullRequestIcon, 'Open pull request', 'state-open']
}

export function StateIcon({ item }: { item: Item }) {
  const [icon, label, className] = stateIcon(item)
  return <Labeled icon={icon} label={label} className={className} />
}

const CI_ICONS: Record<NonNullable<CiState>, Icon> = { SUCCESS: CheckIcon, FAILURE: XIcon, ERROR: XIcon, PENDING: DotFillIcon, EXPECTED: DotFillIcon }
export const CiIcon = ({ ci }: { ci: string }) => (
  <Labeled icon={CI_ICONS[ci as NonNullable<CiState>] ?? DotFillIcon} label={`CI ${ci.toLowerCase()}`} className={`ci-${ci}`} />
)

const REVIEW_ICONS: Record<NonNullable<ReviewDecision>, Icon> = { APPROVED: VerifiedIcon, CHANGES_REQUESTED: FileDiffIcon, REVIEW_REQUIRED: EyeIcon }
export const ReviewIcon = ({ state }: { state: string }) => (
  <Labeled icon={REVIEW_ICONS[state as NonNullable<ReviewDecision>] ?? EyeIcon} label={`Review: ${state.replace('_', ' ').toLowerCase()}`} className={`review-${state}`} />
)

export function AuthorBadge({ item }: { item: Item }) {
  const kind = authorKind(item)
  if (kind === 'member') return null
  return kind === 'bot' ? (
    <span className="badge muted" title="Bot">
      bot
    </span>
  ) : (
    <span className="badge community" title="Community contributor">
      ext
    </span>
  )
}

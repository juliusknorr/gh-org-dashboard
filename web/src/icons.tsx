import type { ReactNode } from 'react'
import type { AiReview } from '../../shared/types.ts'

// Four-pointed star with concave sides, centered on (cx, cy) with radius r.
const sparkle = (cx: number, cy: number, r: number) => {
  const c = r * 0.15
  return `M${cx} ${cy - r}Q${cx + c} ${cy - c} ${cx + r} ${cy}Q${cx + c} ${cy + c} ${cx} ${cy + r}Q${cx - c} ${cy + c} ${cx - r} ${cy}Q${cx - c} ${cy - c} ${cx} ${cy - r}Z`
}

function Svg({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={['line-icon', className].filter(Boolean).join(' ')}
    >
      {children}
    </svg>
  )
}

export const CodingAgentIcon = ({ className }: { className?: string }) => (
  <Svg className={className}>
    <path d="M9 2.75H3.5A1.75 1.75 0 0 0 1.75 4.5v7a1.75 1.75 0 0 0 1.75 1.75h9a1.75 1.75 0 0 0 1.75-1.75V9" />
    <path d="M4.75 6.5 6.75 8.25 4.75 10M8.5 10.25h2.5" />
    <path d={sparkle(12.75, 3.75, 3)} fill="currentColor" stroke="none" />
  </Svg>
)

export const AiReviewIcon = ({ status, className }: { status?: AiReview['status'] | null; className?: string }) => (
  <Svg className={[status && `ai-${status}`, className].filter(Boolean).join(' ')}>
    <circle cx="7.25" cy="6.25" r="4.5" />
    <path d="m10.5 9.5 3.75 3.75" />
    <path className="ai-sparkle" d={sparkle(7.25, 6.25, 2.5)} fill="currentColor" stroke="none" />
    {(status === 'done' || status === 'failed') && (
      <g className="ai-badge">
        <circle cx="3.25" cy="12.75" r="3" stroke="var(--bg)" strokeWidth="1.25" paintOrder="stroke" />
        <path d={status === 'done' ? 'm1.9 12.8.9.9 1.8-1.9' : 'm2.1 11.6 2.3 2.3m0-2.3-2.3 2.3'} stroke="var(--bg)" strokeWidth="1.1" />
      </g>
    )}
  </Svg>
)

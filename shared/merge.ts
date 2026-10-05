import type { ItemDetails, PrDetails, ReviewDecision } from './types.ts'

export interface MergeBlockers {
  hard: string[]
  soft: string[]
}

const NOT_APPROVED = 'Not approved'

export function reviewState(item: ItemDetails['item'], pr: PrDetails): ReviewDecision {
  if (item.reviewDecision === 'CHANGES_REQUESTED' || pr.reviews.some((r) => r.state === 'CHANGES_REQUESTED')) return 'CHANGES_REQUESTED'
  if (item.reviewDecision === 'APPROVED' || (item.reviewDecision === null && pr.reviews.some((r) => r.state === 'APPROVED'))) return 'APPROVED'
  return item.reviewDecision
}

export function mergeBlockers({ item, pr }: ItemDetails): MergeBlockers {
  const hard: string[] = []
  const soft: string[] = []
  if (item.type !== 'pr' || !pr) return { hard: ['Not a pull request'], soft }
  if (item.state !== 'open') hard.push(`Pull request is ${item.state}`)
  if (item.draft) hard.push('Pull request is a draft')
  if (pr.mergeable === 'CONFLICTING') hard.push('Merge conflicts with the base branch')
  if (pr.mergeable === 'UNKNOWN') soft.push('GitHub has not computed mergeability yet')

  if (item.ci === null) soft.push('No CI results')
  else if (item.ci !== 'SUCCESS') soft.push(`CI is ${item.ci.toLowerCase()}`)

  const review = reviewState(item, pr)
  if (review === 'CHANGES_REQUESTED') soft.push('Changes requested')
  else if (review !== 'APPROVED') soft.push(NOT_APPROVED)
  return { hard, soft }
}

export function mergeableOnceApproved(details: ItemDetails): boolean {
  const { hard, soft } = mergeBlockers(details)
  return !hard.length && soft.every((b) => b === NOT_APPROVED)
}

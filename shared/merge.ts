import type { ItemDetails } from './types.ts'

export interface MergeBlockers {
  hard: string[]
  soft: string[]
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

  const changesRequested = item.reviewDecision === 'CHANGES_REQUESTED' || pr.reviews.some((r) => r.state === 'CHANGES_REQUESTED')
  const approved = item.reviewDecision === 'APPROVED' || (item.reviewDecision === null && pr.reviews.some((r) => r.state === 'APPROVED'))
  if (changesRequested) soft.push('Changes requested')
  else if (!approved) soft.push('Not approved')
  return { hard, soft }
}

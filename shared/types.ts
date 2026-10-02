export type ItemType = 'issue' | 'pr'
export type ItemState = 'open' | 'closed' | 'merged'
export type ReviewDecision = 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null
export type CiState = 'SUCCESS' | 'FAILURE' | 'PENDING' | 'ERROR' | 'EXPECTED' | null

export interface Item {
  id: string
  type: ItemType
  repo: string
  number: number
  title: string
  url: string
  state: ItemState
  draft: boolean
  author: string | null
  authorAssociation: string
  assignees: string[]
  labels: { name: string; color: string }[]
  milestone: string | null
  reviewRequests: string[]
  reviewDecision: ReviewDecision
  ci: CiState
  comments: number
  createdAt: string
  updatedAt: string
  closedAt: string | null
}

export interface SyncStatus {
  running: boolean
  lastSyncAt: string | null
  error: string | null
}

export interface ItemsResponse {
  org: string
  items: Item[]
  sync: SyncStatus
}
